const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql/msnodesqlv8');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JSON_SAVE_DIR = process.env.JSON_SAVE_DIR || 'C:\\Data';
const MASTER_CSV_PATH = process.env.MASTER_CSV_PATH || 'C:\\Data\\MasterActivityLog.csv';
const SESSION_CSV_PATH = 'C:\\Data\\MasterActivityLog.csv';
const MANUAL_CSV_PATH = process.env.MANUAL_CSV_PATH || 'C:\\Data\\ManualActivityLog.csv';
const MANUAL_ACTIVITY_FALLBACK_PATH = process.env.MANUAL_ACTIVITY_FALLBACK_PATH || 'C:\\Data\\ManualActivityEntries.csv';
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'tracker.db');
const MASTER_CSV_DIR = path.dirname(MASTER_CSV_PATH);
const MASTER_CSV_NAME = path.basename(MASTER_CSV_PATH).toLowerCase();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Serve static files from the demo folder
app.use(express.static(path.join(__dirname)));

// SQL Server configuration
const dbServer = process.env.DB_SERVER || '(localdb)\\MSSQLLocalDB';
const dbName = process.env.DB_NAME || 'ActivityTracker';
const odbcDriver = process.env.DB_ODBC_DRIVER || 'ODBC Driver 17 for SQL Server';
const connectionString = process.env.DB_CONNECTION_STRING ||
    `Driver={${odbcDriver}};Server=${dbServer};Database=${dbName};Trusted_Connection=Yes;TrustServerCertificate=Yes;`;

const dbConfig = {
    connectionString,
};

let pool;

async function initializeDatabase() {
    try {
        pool = new sql.ConnectionPool(dbConfig);
        await pool.connect();
        console.log('Database connection pool established.');
    } catch (err) {
        console.warn('Database unavailable (SQL Server not running). JSON save routes still work.');
        pool = null;
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

function loadSqliteActivities(dbPath) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
            if (openErr) {
                reject(openErr);
                return;
            }

            ensureSqliteSchema(database, (schemaErr) => {
                if (schemaErr) {
                    database.close(() => reject(schemaErr));
                    return;
                }

                const query = `
                    SELECT
                        id,
                        date,
                        activity_name,
                        duration_minutes,
                        COALESCE(duration_seconds, duration_minutes * 60, 0) AS duration_seconds
                    FROM activities
                    ORDER BY id DESC;
                `;

                database.all(query, [], (queryErr, rows) => {
                    database.close((closeErr) => {
                        if (closeErr) {
                            console.warn('Failed to close SQLite database cleanly:', closeErr.message);
                        }
                    });

                    if (queryErr) {
                        reject(queryErr);
                        return;
                    }

                    resolve(rows || []);
                });
            });
        });
    });
}

function ensureSqliteSchema(database, callback) {
    database.run(`
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            activity_name TEXT,
            duration_minutes INTEGER,
            duration_seconds INTEGER
        )
    `, (createErr) => {
        if (createErr) {
            callback(createErr);
            return;
        }

        database.run('ALTER TABLE activities ADD COLUMN duration_seconds INTEGER', (alterErr) => {
            if (alterErr && !/duplicate column name/i.test(alterErr.message || '')) {
                callback(alterErr);
                return;
            }

            callback(null);
        });
    });
}

function normalizeSqliteActivity(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
        return null;
    }

    const dateValue = String(rawItem.date || '').trim();
    const activityNameValue = String(rawItem.activity_name || rawItem.activityName || '').trim();
    const durationSecondsValue = Number(rawItem.duration_seconds || rawItem.durationSeconds);
    const durationMinutesValue = Number(rawItem.duration_minutes || rawItem.durationMinutes);

    if (dateValue && activityNameValue && Number.isFinite(durationSecondsValue) && durationSecondsValue >= 0) {
        return {
            date: dateValue,
            activity_name: activityNameValue,
            duration_minutes: Math.max(0, Math.floor(durationSecondsValue / 60)),
            duration_seconds: Math.max(0, Math.round(durationSecondsValue)),
        };
    }

    if (dateValue && activityNameValue && Number.isFinite(durationMinutesValue) && durationMinutesValue >= 0) {
        return {
            date: dateValue,
            activity_name: activityNameValue,
            duration_minutes: Math.max(0, Math.round(durationMinutesValue)),
            duration_seconds: Math.max(0, Math.round(durationMinutesValue * 60)),
        };
    }

    const startTime = rawItem.startTime ? new Date(rawItem.startTime) : null;
    const endTime = rawItem.endTime ? new Date(rawItem.endTime) : new Date();
    const hasValidStart = startTime && !Number.isNaN(startTime.getTime());
    const hasValidEnd = endTime && !Number.isNaN(endTime.getTime());

    if (!hasValidEnd) {
        return null;
    }

    const fallbackName = String(rawItem.detail || rawItem.activity || rawItem.category || '').trim();
    if (!fallbackName) {
        return null;
    }

    const baseTime = hasValidStart ? startTime.getTime() : endTime.getTime();
    const durationSeconds = Math.max(0, Math.round((endTime.getTime() - baseTime) / 1000));

    return {
        date: (hasValidStart ? startTime : endTime).toISOString().slice(0, 10),
        activity_name: fallbackName,
        duration_minutes: Math.max(0, Math.floor(durationSeconds / 60)),
        duration_seconds: durationSeconds,
    };
}

function insertSqliteActivities(dbPath, activities) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (openErr) => {
            if (openErr) {
                reject(openErr);
                return;
            }

            const closeDatabase = (callback) => {
                database.close((closeErr) => {
                    if (closeErr) {
                        console.warn('Failed to close SQLite database cleanly:', closeErr.message);
                    }
                    callback();
                });
            };

            database.serialize(() => {
                ensureSqliteSchema(database, (schemaErr) => {
                    if (schemaErr) {
                        closeDatabase(() => reject(schemaErr));
                        return;
                    }

                    if (!activities.length) {
                        closeDatabase(() => resolve(0));
                        return;
                    }

                    database.run('BEGIN TRANSACTION', (beginErr) => {
                        if (beginErr) {
                            closeDatabase(() => reject(beginErr));
                            return;
                        }

                        const statement = database.prepare(
                            'INSERT INTO activities (date, activity_name, duration_minutes, duration_seconds) VALUES (?, ?, ?, ?)'
                        );

                        let completed = 0;
                        let failed = false;

                        activities.forEach((item) => {
                            statement.run(
                                [
                                    item.date,
                                    item.activity_name,
                                    item.duration_minutes,
                                    item.duration_seconds,
                                ],
                                (insertErr) => {
                                if (failed) {
                                    return;
                                }

                                if (insertErr) {
                                    failed = true;
                                    statement.finalize(() => {
                                        database.run('ROLLBACK', () => {
                                            closeDatabase(() => reject(insertErr));
                                        });
                                    });
                                    return;
                                }

                                completed += 1;
                                if (completed !== activities.length) {
                                    return;
                                }

                                statement.finalize((finalizeErr) => {
                                    if (finalizeErr) {
                                        database.run('ROLLBACK', () => {
                                            closeDatabase(() => reject(finalizeErr));
                                        });
                                        return;
                                    }

                                    database.run('COMMIT', (commitErr) => {
                                        if (commitErr) {
                                            database.run('ROLLBACK', () => {
                                                closeDatabase(() => reject(commitErr));
                                            });
                                            return;
                                        }

                                        closeDatabase(() => resolve(completed));
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

async function ensureJsonSaveDir() {
    await fs.mkdir(JSON_SAVE_DIR, { recursive: true });
}

async function ensureCsvFileWithHeader(filePath, headerLine) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, headerLine + '\n', 'utf8');
    }
}

function sanitizeFileName(name) {
    return String(name || '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
}

function csvEscapeValue(value) {
    const text = value == null ? '' : String(value);
    if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

function parseCsvRows(text) {
    const rows = [];
    let current = '';
    let row = [];
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            row.push(current);
            current = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            row.push(current);
            if (row.some((cell) => cell !== '')) {
                rows.push(row);
            }
            row = [];
            current = '';
        } else {
            current += char;
        }
    }

    if (current !== '' || row.length > 0) {
        row.push(current);
        if (row.some((cell) => cell !== '')) {
            rows.push(row);
        }
    }

    return rows;
}

function parseMasterCsvSessions(text) {
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
        return [];
    }

    const headers = rows[0].map((cell) => String(cell || '').trim().toLowerCase());
    const uploadIdIndex = headers.indexOf('uploadid');
    const categoryIndex = headers.indexOf('category');
    const detailIndex = headers.indexOf('detail');
    const tagsIndex = headers.indexOf('tags');
    const startIndex = headers.indexOf('start');
    const endIndex = headers.indexOf('end');

    if (startIndex === -1 || endIndex === -1) {
        throw new Error('Master CSV must include Start and End columns.');
    }

    return rows.slice(1).map((row) => {
        const uploadRaw = uploadIdIndex === -1 ? null : String(row[uploadIdIndex] || '').trim();
        const parsedUploadId = Number(uploadRaw);

        return {
            uploadId: Number.isInteger(parsedUploadId) && parsedUploadId > 0 ? parsedUploadId : null,
            category: categoryIndex === -1 ? 'Custom' : String(row[categoryIndex] || '').trim() || 'Custom',
            detail: detailIndex === -1 ? '' : String(row[detailIndex] || '').trim(),
            tags: tagsIndex === -1 ? '' : String(row[tagsIndex] || '').trim(),
            startTime: String(row[startIndex] || '').trim() || null,
            endTime: String(row[endIndex] || '').trim() || null
        };
    }).filter((session) => session.startTime || session.endTime);
}

async function ensureManualActivityTable() {
    if (!pool) {
        throw new Error('Database connection is not available.');
    }

    const request = pool.request();
    await request.query(`
        IF OBJECT_ID(N'dbo.ManualActivityEntry', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.ManualActivityEntry
            (
                EntryId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
                Activity NVARCHAR(400) NOT NULL,
                DurationMinutes INT NOT NULL,
                CreatedAtUtc DATETIME2(0) NOT NULL CONSTRAINT DF_ManualActivityEntry_CreatedAtUtc DEFAULT (SYSUTCDATETIME())
            );
        END
    `);
}

function getAdvancedPowerQueryM() {
    return [
        'let',
        '    // SQL equivalent: SELECT * FROM ExternalCsvFile(\'C:\\Data\\MasterActivityLog.csv\')',
        '    Source = Csv.Document(',
        '        File.Contents("C:\\Data\\MasterActivityLog.csv"),',
        '        [',
        '            Delimiter = ",",',
        '            Encoding = 65001,',
        '            QuoteStyle = QuoteStyle.Csv',
        '        ]',
        '    ),',
        '',
        '    // SQL equivalent: SELECT * FROM SourceData WITH first_row_as_column_names',
        '    PromotedHeaders = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),',
        '',
        '    // SQL equivalent: SELECT CAST(UploadId AS varchar), CAST(Category AS varchar), CAST(Detail AS varchar), CAST(Start AS datetime), CAST([End] AS datetime) FROM ...',
        '    TypedTextColumns = Table.TransformColumnTypes(',
        '        PromotedHeaders,',
        '        {',
        '            {"UploadId", type text},',
        '            {"Category", type text},',
        '            {"Detail", type text}',
        '        }',
        '    ),',
        '',
        '    // SQL equivalent: TRY_CAST(Start AS datetime), TRY_CAST([End] AS datetime)',
        '    ParsedDateTimes = Table.TransformColumns(',
        '        TypedTextColumns,',
        '        {',
        '            {"Start", each try DateTime.From(_) otherwise null, type nullable datetime},',
        '            {"End", each try DateTime.From(_) otherwise null, type nullable datetime}',
        '        }',
        '    ),',
        '',
        '    // SQL equivalent: SELECT *, CAST((DATEDIFF(second, Start, [End]) / 3600.0) AS decimal(18,4)) AS DurationHours FROM ...',
        '    AddedDurationHours = Table.AddColumn(',
        '        ParsedDateTimes,',
        '        "DurationHours",',
        '        each if [Start] <> null and [#"End"] <> null then Duration.TotalDays([#"End"] - [Start]) * 24 else null,',
        '        type nullable number',
        '    ),',
        '',
        '    // SQL equivalent: SELECT * FROM ... WHERE Category IS NOT NULL AND DurationHours > 0',
        '    FilteredRows = Table.SelectRows(',
        '        AddedDurationHours,',
        '        each [Category] <> null and Text.Trim([Category]) <> "" and [DurationHours] <> null and [DurationHours] > 0',
        '    )',
        'in',
        '    FilteredRows'
    ].join('\n');
}

app.get('/api/activity/load-master-csv', async (req, res) => {
    try {
        const entries = await fs.readdir(MASTER_CSV_DIR, { withFileTypes: true });
        const csvFiles = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
            .map((entry) => entry.name);

        if (csvFiles.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No CSV files found in ${MASTER_CSV_DIR}`,
                folderPath: MASTER_CSV_DIR,
            });
        }

        let selectedName = csvFiles.find((name) => name.toLowerCase() === MASTER_CSV_NAME);

        if (!selectedName) {
            const filesWithStats = await Promise.all(csvFiles.map(async (name) => {
                const fullPath = path.join(MASTER_CSV_DIR, name);
                const stats = await fs.stat(fullPath);
                return {
                    name,
                    fullPath,
                    mtimeMs: stats.mtimeMs,
                };
            }));

            filesWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
            selectedName = filesWithStats[0].name;
        }

        const selectedPath = path.join(MASTER_CSV_DIR, selectedName);
        const raw = await fs.readFile(selectedPath, 'utf8');
        const sessions = parseMasterCsvSessions(raw);

        res.json({
            success: true,
            filePath: selectedPath,
            sourceLabel: 'c-data-master-csv',
            sessions,
            count: sessions.length,
            folderPath: MASTER_CSV_DIR,
        });
    } catch (err) {
        const status = err.code === 'ENOENT' ? 404 : 500;
        res.status(status).json({
            success: false,
            error: err.code === 'ENOENT'
                ? `CSV folder or file not found at ${MASTER_CSV_DIR}`
                : 'Failed to load master CSV.',
            details: err.message,
            filePath: MASTER_CSV_PATH,
            folderPath: MASTER_CSV_DIR,
        });
    }
});

app.get('/api/activity/advanced-query', (req, res) => {
    res.json({
        success: true,
        filePath: MASTER_CSV_PATH,
        mCode: getAdvancedPowerQueryM(),
    });
});

app.post('/api/activity/save-json', async (req, res) => {
    const { sessions, fileName } = req.body || {};

    if (!Array.isArray(sessions)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid input: sessions must be an array.',
        });
    }

    if (sessions.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No sessions to save.',
        });
    }

    try {
        await ensureJsonSaveDir();

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const requestedName = sanitizeFileName(fileName) || 'activityHistory';
        const safeFileName = requestedName.toLowerCase().endsWith('.json')
            ? requestedName
            : `${requestedName}-${stamp}.json`;

        const targetPath = path.join(JSON_SAVE_DIR, safeFileName);
        const payload = JSON.stringify(sessions, null, 2);
        await fs.writeFile(targetPath, payload, 'utf8');

        res.json({
            success: true,
            fileName: safeFileName,
            relativePath: safeFileName,
            fullPath: targetPath,
            sessionCount: sessions.length,
            message: `Saved ${sessions.length} sessions to ${safeFileName}.`,
        });
    } catch (err) {
        console.error('Error saving sessions to disk:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to save JSON file.',
            details: err.message,
        });
    }
});

app.post('/api/save-session', async (req, res) => {
    const { uploadId, category, detail, tags, start, end } = req.body || {};

    const requiredKeys = ['uploadId', 'category', 'detail', 'tags', 'start', 'end'];
    const hasAllRequiredKeys = requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));

    if (!hasAllRequiredKeys) {
        return res.status(400).json({
            success: false,
            error: 'Request body must include: uploadId, category, detail, tags, start, end.',
        });
    }

    try {
        const row = [uploadId, category, detail, tags, start, end]
            .map(csvEscapeValue)
            .join(',') + '\n';

        await fs.appendFile(SESSION_CSV_PATH, row, 'utf8');

        return res.status(200).json({
            success: true,
            message: 'Session saved to CSV.',
            filePath: SESSION_CSV_PATH,
        });
    } catch (err) {
        console.error('Error appending session to CSV:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to append session to CSV.',
            details: err.message,
            filePath: SESSION_CSV_PATH,
        });
    }
});

app.post('/api/save-manual-session', async (req, res) => {
    const { category, detail, tags, start, end } = req.body || {};

    const requiredKeys = ['category', 'detail', 'tags', 'start', 'end'];
    const hasAllRequiredKeys = requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));

    if (!hasAllRequiredKeys) {
        return res.status(400).json({
            success: false,
            error: 'Request body must include: category, detail, tags, start, end.',
        });
    }

    try {
        await ensureCsvFileWithHeader(MANUAL_CSV_PATH, 'UploadId,Category,Detail,Tags,Start,End');

        const row = ['', category, detail, tags, start, end]
            .map(csvEscapeValue)
            .join(',') + '\n';

        await fs.appendFile(MANUAL_CSV_PATH, row, 'utf8');

        return res.status(200).json({
            success: true,
            message: 'Manual session saved to CSV.',
            filePath: MANUAL_CSV_PATH,
        });
    } catch (err) {
        console.error('Error appending manual session to CSV:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to append manual session to CSV.',
            details: err.message,
            filePath: MANUAL_CSV_PATH,
        });
    }
});

app.post('/api/manual-activity', async (req, res) => {
    const activity = String((req.body && req.body.activity) || '').trim();
    const durationMinutes = Number((req.body && req.body.durationMinutes));
    const createdAtRaw = String((req.body && req.body.createdAtUtc) || '').trim();

    if (!activity) {
        return res.status(400).json({
            success: false,
            error: 'activity is required.',
        });
    }

    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return res.status(400).json({
            success: false,
            error: 'durationMinutes must be a positive number.',
        });
    }

    if (!pool) {
        const createdAt = createdAtRaw || new Date().toISOString();
        const row = [createdAt, activity, Math.round(durationMinutes)]
            .map(csvEscapeValue)
            .join(',') + '\n';

        try {
            await ensureCsvFileWithHeader(MANUAL_ACTIVITY_FALLBACK_PATH, 'CreatedAtUtc,Activity,DurationMinutes');
            await fs.appendFile(MANUAL_ACTIVITY_FALLBACK_PATH, row, 'utf8');
        } catch (fallbackError) {
            console.error('Manual activity fallback write failed:', fallbackError.message);
        }

        return res.status(503).json({
            success: false,
            error: 'Database unavailable. Saved to fallback CSV for later import.',
            fallbackPath: MANUAL_ACTIVITY_FALLBACK_PATH,
        });
    }

    try {
        await ensureManualActivityTable();

        const request = pool.request();
        request.input('Activity', sql.NVarChar(400), activity);
        request.input('DurationMinutes', sql.Int, Math.round(durationMinutes));

        const result = await request.query(`
            INSERT INTO dbo.ManualActivityEntry (Activity, DurationMinutes)
            OUTPUT INSERTED.EntryId, INSERTED.Activity, INSERTED.DurationMinutes, INSERTED.CreatedAtUtc
            VALUES (@Activity, @DurationMinutes);
        `);

        return res.status(200).json({
            success: true,
            entry: result.recordset && result.recordset[0] ? result.recordset[0] : null,
            message: 'Manual activity saved to SQL Server.',
        });
    } catch (err) {
        console.error('Error saving manual activity to SQL Server:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to save manual activity.',
            details: err.message,
        });
    }
});

// Upload activity history
app.post('/api/activity/upload', async (req, res) => {
    const { sessions, fileName, sourceLabel } = req.body;

    if (!sessions || !Array.isArray(sessions)) {
        return res.status(400).json({ error: 'Invalid input: sessions must be an array.' });
    }

    if (sessions.length === 0) {
        return res.status(400).json({ error: 'No sessions to upload.' });
    }

    try {
        const jsonData = JSON.stringify(sessions);
        const cleanFileName = fileName || 'tracker-upload.json';
        const source = sourceLabel || 'html-tracker';

        const request = pool.request();
        request.input('FileName', sql.NVarChar(260), cleanFileName);
        request.input('JsonData', sql.NVarChar(sql.MAX), jsonData);
        request.input('SourceLabel', sql.NVarChar(100), source);

        const result = await request.execute('dbo.ImportActivityHistoryJson');

        if (result.recordsets && result.recordsets[0]) {
            const importResult = result.recordsets[0][0];
            return res.json({
                success: true,
                uploadId: importResult.UploadId,
                fileName: importResult.FileName,
                sessionCount: importResult.SessionCount,
                uploadedAt: importResult.UploadedAt,
                message: `Successfully imported ${importResult.SessionCount} sessions.`,
            });
        }

        res.json({
            success: true,
            message: `Successfully imported ${sessions.length} sessions.`,
        });
    } catch (err) {
        console.error('Error importing sessions:', err.message);
        res.status(500).json({
            error: 'Failed to import sessions.',
            details: err.message,
        });
    }
});

// Get all sessions
app.get('/api/activity/sessions', async (req, res) => {
    try {
        const request = pool.request();
        const result = await request.query('SELECT * FROM dbo.vwActivitySessions ORDER BY StartTimeUtc DESC;');

        res.json({
            success: true,
            sessions: result.recordset,
            count: result.recordset.length,
        });
    } catch (err) {
        console.error('Error fetching sessions:', err.message);
        res.status(500).json({
            error: 'Failed to fetch sessions.',
            details: err.message,
        });
    }
});

// Compatibility endpoint for tracker.db pipeline (HTML -> CSV -> Python -> SQLite -> UI)
app.get('/api/activities', async (req, res) => {
    try {
        await fs.access(SQLITE_DB_PATH);
    } catch {
        return res.json({
            success: true,
            activities: [],
            count: 0,
            dbPath: SQLITE_DB_PATH,
            message: 'SQLite database not found yet. Run tracker_csv_to_sqlite.py after creating raw_logs.csv.'
        });
    }

    try {
        const activities = await loadSqliteActivities(SQLITE_DB_PATH);
        res.json({
            success: true,
            activities,
            count: activities.length,
            dbPath: SQLITE_DB_PATH
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: 'Failed to read SQLite activities.',
            details: err.message,
            dbPath: SQLITE_DB_PATH
        });
    }
});

app.post('/api/activities/import', async (req, res) => {
    const payload = req.body || {};
    const candidates = Array.isArray(payload.activities)
        ? payload.activities
        : Array.isArray(payload.sessions)
            ? payload.sessions
            : payload.activity
                ? [payload.activity]
                : Object.keys(payload).length > 0
                    ? [payload]
                    : [];

    const normalized = candidates
        .map(normalizeSqliteActivity)
        .filter((item) => item && item.activity_name);

    if (normalized.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No valid activity rows provided. Expected date, activity_name, duration_minutes or a session with startTime/endTime.',
        });
    }

    try {
        const inserted = await insertSqliteActivities(SQLITE_DB_PATH, normalized);
        res.json({
            success: true,
            inserted,
            count: normalized.length,
            dbPath: SQLITE_DB_PATH,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: 'Failed to import rows into SQLite.',
            details: err.message,
            dbPath: SQLITE_DB_PATH,
        });
    }
});

// Get sessions summary
app.get('/api/activity/summary', async (req, res) => {
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT
                ActivityName,
                COUNT(*) AS SessionCount,
                SUM(DurationSeconds) / 3600.0 AS TotalHours
            FROM dbo.vwActivitySessions
            GROUP BY ActivityName
            ORDER BY TotalHours DESC;
        `);

        res.json({
            success: true,
            summary: result.recordset,
        });
    } catch (err) {
        console.error('Error fetching summary:', err.message);
        res.status(500).json({
            error: 'Failed to fetch summary.',
            details: err.message,
        });
    }
});

// ============ Safe Cleanup Endpoints ============

app.get('/api/cleanup/uploads', async (req, res) => {
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT TOP (25)
                UploadId,
                FileName,
                SourceLabel,
                UploadedAt,
                SessionCount
            FROM dbo.ActivityUpload
            ORDER BY UploadId DESC;
        `);

        res.json({
            success: true,
            uploads: result.recordset,
            count: result.recordset.length,
        });
    } catch (err) {
        console.error('Error listing uploads for cleanup:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to list uploads.',
            details: err.message,
        });
    }
});

app.post('/api/cleanup/preview-delete-upload', async (req, res) => {
    const uploadId = Number(req.body && req.body.uploadId);

    if (!Number.isInteger(uploadId) || uploadId <= 0) {
        return res.status(400).json({
            success: false,
            error: 'uploadId must be a positive integer.',
        });
    }

    try {
        const request = pool.request();
        request.input('UploadId', sql.Int, uploadId);

        const result = await request.query(`
            SELECT
                u.UploadId,
                u.FileName,
                u.SourceLabel,
                u.UploadedAt,
                u.SessionCount,
                COUNT(s.SessionId) AS SessionRowsToDelete
            FROM dbo.ActivityUpload AS u
            LEFT JOIN dbo.ActivitySession AS s
                ON s.UploadId = u.UploadId
            WHERE u.UploadId = @UploadId
            GROUP BY
                u.UploadId,
                u.FileName,
                u.SourceLabel,
                u.UploadedAt,
                u.SessionCount;
        `);

        if (!result.recordset || result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                error: `UploadId ${uploadId} was not found.`,
            });
        }

        const preview = result.recordset[0];
        res.json({
            success: true,
            preview,
            message: 'Preview only. No rows were deleted.',
        });
    } catch (err) {
        console.error('Error previewing cleanup:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to preview cleanup.',
            details: err.message,
        });
    }
});

app.post('/api/cleanup/commit-delete-upload', async (req, res) => {
    const uploadId = Number(req.body && req.body.uploadId);
    const confirmText = String((req.body && req.body.confirmText) || '').trim();

    if (!Number.isInteger(uploadId) || uploadId <= 0) {
        return res.status(400).json({
            success: false,
            error: 'uploadId must be a positive integer.',
        });
    }

    if (confirmText !== 'DELETE') {
        return res.status(400).json({
            success: false,
            error: 'Confirmation text must be exactly DELETE.',
        });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        const preReq = new sql.Request(transaction);
        preReq.input('UploadId', sql.Int, uploadId);
        const pre = await preReq.query(`
            SELECT
                UploadId,
                FileName,
                SourceLabel,
                UploadedAt,
                SessionCount
            FROM dbo.ActivityUpload
            WHERE UploadId = @UploadId;
        `);

        if (!pre.recordset || pre.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                error: `UploadId ${uploadId} was not found. Nothing deleted.`,
            });
        }

        const deleteSessionsReq = new sql.Request(transaction);
        deleteSessionsReq.input('UploadId', sql.Int, uploadId);
        const deleteSessions = await deleteSessionsReq.query(`
            DELETE FROM dbo.ActivitySession
            WHERE UploadId = @UploadId;
        `);

        const deleteUploadReq = new sql.Request(transaction);
        deleteUploadReq.input('UploadId', sql.Int, uploadId);
        const deleteUpload = await deleteUploadReq.query(`
            DELETE FROM dbo.ActivityUpload
            WHERE UploadId = @UploadId;
        `);

        await transaction.commit();

        res.json({
            success: true,
            deletedUploadId: uploadId,
            deletedSessionRows: deleteSessions.rowsAffected[0] || 0,
            deletedUploadRows: deleteUpload.rowsAffected[0] || 0,
            deletedUpload: pre.recordset[0],
            message: `Committed delete for UploadId ${uploadId}.`,
        });
    } catch (err) {
        try {
            if (transaction._aborted !== true) {
                await transaction.rollback();
            }
        } catch (rollbackError) {
            console.error('Cleanup rollback failed:', rollbackError.message);
        }

        console.error('Error committing cleanup:', err.message);
        res.status(500).json({
            success: false,
            error: 'Cleanup commit failed. Transaction rolled back.',
            details: err.message,
        });
    }
});

// ============ Server Control Endpoints ============

const serverBootIso = new Date().toISOString();

// Server Status
app.post('/api/server/status', async (req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    res.json({
        success: true,
        message: `RUNNING (pid ${process.pid}) - uptime ${uptimeSeconds}s - started ${serverBootIso}`,
        timestamp: new Date().toISOString(),
    });
});

// Server Start
app.post('/api/server/start', async (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Start is not available via API in this setup. Start manually with: node server.js',
        timestamp: new Date().toISOString(),
    });
});

// Server Stop
app.post('/api/server/stop', async (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Stop is not available via API in this setup. Stop manually in the terminal running node server.js',
        timestamp: new Date().toISOString(),
    });
});

// Server Restart
app.post('/api/server/restart', async (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Restart is not available via API in this setup. Restart manually by stopping and re-running node server.js',
        timestamp: new Date().toISOString(),
    });
});

// Start server
async function startServer() {
    await ensureJsonSaveDir();
    await initializeDatabase();

    const server = app.listen(PORT, () => {
        console.log(`Activity Tracker server running at http://localhost:${PORT}`);
        console.log('Endpoints:');
        console.log(`  POST /api/server/status - Check server status`);
        console.log(`  POST /api/server/start - Start server`);
        console.log(`  POST /api/server/stop - Stop server`);
        console.log(`  POST /api/server/restart - Restart server`);
        console.log(`  POST /api/activity/upload - Upload activity history`);
        console.log(`  POST /api/manual-activity - Save activity + duration to SQL Server`);
        console.log(`  POST /api/activity/save-json - Save activity history to ${JSON_SAVE_DIR}`);
        console.log(`  GET  /api/activity/sessions - View all sessions`);
        console.log(`  GET  /api/activity/summary - View activity summary`);
        console.log(`  GET  /api/activities - View SQLite tracker rows`);
        console.log(`  POST /api/activities/import - Import rows into SQLite tracker`);
        console.log(`  GET  /api/cleanup/uploads - List latest uploads for safe cleanup`);
        console.log(`  POST /api/cleanup/preview-delete-upload - Preview cleanup by UploadId`);
        console.log(`  POST /api/cleanup/commit-delete-upload - Commit cleanup by UploadId`);
        console.log(`  GET  /health - Server health check`);
    });

    server.on('error', async (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. The server is likely already running at http://localhost:${PORT}`);
            console.error('Use the existing server, stop the other Node process, or start this server with a different PORT value.');
        } else {
            console.error('Server startup failed:', err.message || JSON.stringify(err));
        }

        if (pool) {
            await pool.close();
        }

        process.exit(1);
    });
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    if (pool) {
        await pool.close();
    }
    process.exit(0);
});

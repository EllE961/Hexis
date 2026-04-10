use rusqlite::{Connection, Result, params};
use crate::{FileInfo, GroupInfo};

/// Initialize the database schema (7 tables)
pub fn initialize(conn: &Connection) -> Result<()> {
    // Enable WAL mode for concurrent reads
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    conn.execute_batch("
        -- Core file data
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            extension TEXT,
            group_path TEXT NOT NULL,
            language TEXT,
            importance_score REAL DEFAULT 0,
            content_hash TEXT,
            last_modified INTEGER,
            size_bytes INTEGER,
            is_landmark BOOLEAN DEFAULT FALSE,
            is_test BOOLEAN DEFAULT FALSE,
            is_config BOOLEAN DEFAULT FALSE,
            is_generated BOOLEAN DEFAULT FALSE
        );

        -- Directory groups
        CREATE TABLE IF NOT EXISTS groups (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_path TEXT,
            depth INTEGER DEFAULT 0,
            section_color TEXT,
            is_collapsed BOOLEAN DEFAULT FALSE,
            file_count INTEGER DEFAULT 0,
            health_score REAL DEFAULT 1.0
        );

        -- Hex grid positions
        CREATE TABLE IF NOT EXISTS hex_layout (
            file_path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
            q INTEGER NOT NULL,
            r INTEGER NOT NULL,
            group_path TEXT NOT NULL REFERENCES groups(path),
            UNIQUE(q, r)
        );

        -- File relationships
        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
            target_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
            type TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            UNIQUE(source_path, target_path, type)
        );

        -- User sessions
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            project_path TEXT NOT NULL,
            zoom_level REAL DEFAULT 1.0,
            viewport_x REAL DEFAULT 0,
            viewport_y REAL DEFAULT 0,
            active_branch TEXT,
            open_files TEXT
        );

        -- User preferences
        CREATE TABLE IF NOT EXISTS preferences (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Knowledge graph / memory
        CREATE TABLE IF NOT EXISTS memory (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT,
            related_files TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            source TEXT
        );

        -- Indexes for performance
        CREATE INDEX IF NOT EXISTS idx_files_group ON files(group_path);
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_path);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_path);
        CREATE INDEX IF NOT EXISTS idx_hex_layout_qr ON hex_layout(q, r);
        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
    ")?;

    Ok(())
}

/// Insert scan results into the database
pub fn insert_scan_results(conn: &Connection, files: &[FileInfo], groups: &[GroupInfo]) -> Result<()> {
    // Clear existing data
    conn.execute("DELETE FROM hex_layout", [])?;
    conn.execute("DELETE FROM edges", [])?;
    conn.execute("DELETE FROM files", [])?;
    conn.execute("DELETE FROM groups", [])?;

    // Insert groups
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO groups (path, name, parent_path, depth) VALUES (?1, ?2, ?3, ?4)"
    )?;
    for group in groups {
        stmt.execute(params![group.path, group.name, group.parent_path, group.depth])?;
    }

    // Also insert root group
    conn.execute(
        "INSERT OR REPLACE INTO groups (path, name, depth) VALUES ('.', 'root', 0)",
        [],
    )?;

    // Insert files
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO files (path, name, extension, group_path, size_bytes, is_landmark, is_test, is_config) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    )?;
    for file in files {
        let is_landmark = is_landmark_file(&file.name);
        let is_test = is_test_file(&file.name, &file.path);
        let is_config = is_config_file(&file.name, file.extension.as_deref());
        stmt.execute(params![
            file.path, file.name, file.extension, file.group_path,
            file.size_bytes, is_landmark, is_test, is_config
        ])?;
    }

    // Update group file counts
    conn.execute_batch("
        UPDATE groups SET file_count = (
            SELECT COUNT(*) FROM files WHERE files.group_path = groups.path
        );
    ")?;

    Ok(())
}

/// Get all files from the database
pub fn get_all_files(conn: &Connection) -> Result<Vec<FileInfo>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, extension, group_path, size_bytes FROM files"
    )?;
    let files = stmt.query_map([], |row| {
        Ok(FileInfo {
            path: row.get(0)?,
            name: row.get(1)?,
            extension: row.get(2)?,
            group_path: row.get(3)?,
            size_bytes: row.get(4)?,
            is_directory: false,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(files)
}

/// Get all groups from the database
pub fn get_all_groups(conn: &Connection) -> Result<Vec<GroupInfo>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, parent_path, depth, file_count FROM groups"
    )?;
    let groups = stmt.query_map([], |row| {
        Ok(GroupInfo {
            path: row.get(0)?,
            name: row.get(1)?,
            parent_path: row.get(2)?,
            depth: row.get(3)?,
            file_count: row.get(4)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(groups)
}

fn is_landmark_file(name: &str) -> bool {
    let landmarks = ["index", "main", "app", "mod", "__init__", "lib"];
    let stem = name.split('.').next().unwrap_or("");
    landmarks.iter().any(|l| stem.eq_ignore_ascii_case(l))
}

fn is_test_file(name: &str, path: &str) -> bool {
    name.contains(".test.") || name.contains(".spec.") ||
    name.contains("_test.") || name.contains("_spec.") ||
    path.contains("__tests__") || path.contains("/test/") || path.contains("/tests/")
}

fn is_config_file(name: &str, ext: Option<&str>) -> bool {
    let configs = [".env", "package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml",
                   "vite.config", "webpack.config", "tailwind.config", "docker-compose",
                   "Dockerfile", "Makefile", ".eslintrc", ".prettierrc"];
    configs.iter().any(|c| name.contains(c)) ||
    matches!(ext, Some("toml") | Some("yaml") | Some("yml"))
}

/**
 * Database connection — shared with marketplace (same MySQL DB).
 *
 * Adds the buildJobs table for tracking compilation status.
 */

import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export interface BuildJob {
  id: number;
  pluginId: number;
  version: string;
  platform: string;
  hubJobId: string;
  status: string; // queued, building, completed, failed
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

export async function initDb(config: {
  dbHost: string;
  dbUser: string;
  dbPass: string;
  dbName: string;
}): Promise<void> {
  pool = mysql.createPool({
    host: config.dbHost,
    user: config.dbUser,
    password: config.dbPass,
    database: config.dbName,
    waitForConnections: true,
    connectionLimit: 5,
  });

  // Create buildJobs table if it doesn't exist
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS buildJobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pluginId INT NOT NULL,
      version VARCHAR(32) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      hubJobId VARCHAR(64),
      status VARCHAR(20) DEFAULT 'queued',
      errorMessage TEXT,
      createdAt BIGINT,
      completedAt BIGINT,
      FOREIGN KEY (pluginId) REFERENCES plugins(id),
      INDEX idxPluginVersion (pluginId, version),
      INDEX idxStatus (status)
    )
  `);

  console.log('DB connected and buildJobs table ready');
}

export function getDb(): mysql.Pool {
  if (!pool) {
    throw new Error('Database not initialized — call initDb() first');
  }
  return pool;
}

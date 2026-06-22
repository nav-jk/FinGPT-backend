import pg from 'pg';
const { Pool } = pg;

const connString = process.env.POSTGRES_URL_NON_POOLING?.replace('sslmode=require', 'sslmode=no-verify');

export const pool = new Pool({
    connectionString: connString,
    ssl: { rejectUnauthorized: false }
});

export async function query(text, params) {
    const client = await pool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
}
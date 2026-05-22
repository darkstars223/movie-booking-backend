const mysql = require('mysql2');
require('dotenv').config();

// Tạo kết nối dưới dạng Pool để tối ưu hiệu suất
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Xuất ra dưới dạng Promise để dùng async/await cho dễ
const promisePool = pool.promise();

// Export cả pool.promise() cho các query thông thường
module.exports = promisePool;
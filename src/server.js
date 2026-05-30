const express = require('express');
const cors = require('cors');
const db = require('./configs/db');
require('dotenv').config();
const path = require('path');
const app = express();

const movieRoutes = require('./routes/movieRoutes'); 
const authRoutes = require('./routes/authRoutes');
const aiRoutes = require('./routes/aiRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const showtimeRoutes = require('./routes/showtimeRoutes');
const adminRoutes = require('./routes/adminRoutes');
const debugRoutes = require('./routes/debugRoutes'); 

// Middleware
app.use(cors({
    origin: ['https://movie-booking-frontend-nine.vercel.app'], // URL sau khi deploy Vercel
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json()); 

// Routes
app.use('/api/movies', movieRoutes); 
app.use('/api/bookings', bookingRoutes); 
app.use('/api/showtimes', showtimeRoutes); 
app.use('/api/ai', aiRoutes); 
app.use('/api/auth', authRoutes); 
app.use('/api/admin', adminRoutes); 
app.use('/api/debug', debugRoutes); 
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.get('/', (req, res) => {
    res.send('Server đặt vé xem phim đang chạy!');
});

// Kiểm tra kết nối Database khi khởi động
async function checkDB() {
    try {
        const [rows] = await db.query('SELECT 1 + 1 AS result');
        console.log(' Kết nối MySQL thành công!');
    } catch (err) {
        console.error(' Lỗi kết nối MySQL:', err.message);
    }
}
checkDB();

 
setInterval(async () => {
    try {
        // 0. Làm sạch các status không hợp lệ từ lỗi trước
        const sqlCleanup = `
            UPDATE bookings 
            SET status = 'cancel' 
            WHERE status = 'cancelled'
        `;
        await db.query(sqlCleanup);

        // 1. Tự động hủy giữ chỗ quá 10 phút (Tính từ lúc đặt vé - booking_time)
        const sqlCancelPending = `
            UPDATE bookings 
            SET status = 'cancel' 
            WHERE status = 'pending' AND booking_time <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        `;
        const [cancelResult] = await db.query(sqlCancelPending);
        if (cancelResult.affectedRows > 0) {
            console.log(`⚙️ [Hệ thống]: Đã hủy tự động ${cancelResult.affectedRows} vé quá hạn 10 phút.`);
        }

        // 2. Tự động chuyển vé 'confirmed' sang 'expired' khi suất chiếu đã kết thúc
        const sqlExpireConfirmed = `
            UPDATE bookings b
            INNER JOIN showtimes s ON b.showtime_id = s.id
            INNER JOIN movies m ON s.movie_id = m.id
            SET b.status = 'cancel'
            WHERE b.status = 'confirmed' 
            AND s.start_time IS NOT NULL
            AND TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time) <= NOW()
        `;
        const [expireResult] = await db.query(sqlExpireConfirmed);
        if (expireResult.affectedRows > 0) {
            console.log(`⚙️ [Hệ thống]: Đã chuyển ${expireResult.affectedRows} vé sang trạng thái 'Đã hết hạn'.`);
        }

    } catch (error) {
        console.error('❌ Lỗi tiến trình tự động xử lý vé:', error.message);
    }
}, 60000);    
 

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(` Server is running on port ${PORT}`);
});

//npm run dev 
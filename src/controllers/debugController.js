// File: src/controllers/debugController.js
// Thêm controller này để debug vấn đề

const db = require('../configs/db');

// Kiểm tra tất cả vé trong database
exports.getAllBookings = async (req, res) => {
    try {
        const connection = await db.getConnection();
        const [bookings] = await connection.query(
            `SELECT b.id, b.user_id, b.showtime_id, b.seat_id, b.total_price, b.status, LENGTH(b.status) as status_length,
                    b.booking_time, m.title, s.start_time, st.seat_number
             FROM bookings b
             LEFT JOIN showtimes s ON b.showtime_id = s.id
             LEFT JOIN movies m ON s.movie_id = m.id
             LEFT JOIN seats st ON b.seat_id = st.id
             ORDER BY b.id DESC`
        );
        
        // Thống kê status
        const statusCount = {};
        bookings.forEach(b => {
            statusCount[b.status] = (statusCount[b.status] || 0) + 1;
        });
        
        connection.release();
        res.status(200).json({
            total: bookings.length,
            statusCount,
            bookings
        });
    } catch (error) {
        console.error("Lỗi lấy vé:", error);
        res.status(500).json({ message: "Lỗi lấy danh sách vé", error: error.message });
    }
};

// Kiểm tra tất cả users
exports.getAllUsers = async (req, res) => {
    try {
        const connection = await db.getConnection();
        const [users] = await connection.query('SELECT id, fullname, email, role FROM users');
        connection.release();
        res.status(200).json(users);
    } catch (error) {
        console.error("Lỗi lấy users:", error);
        res.status(500).json({ message: "Lỗi lấy danh sách users", error: error.message });
    }
};

// Lấy vé của một user cụ thể với chi tiết
exports.getUserTicketsDebug = async (req, res) => {
    try {
        const { user_id } = req.params;
        const connection = await db.getConnection();

        // Kiểm tra user có tồn tại không
        const [user] = await connection.query('SELECT * FROM users WHERE id = ?', [user_id]);
        if (user.length === 0) {
            connection.release();
            return res.status(404).json({ message: "User không tồn tại", user_id });
        }

        // Lấy vé của user
        const [tickets] = await connection.query(
            `SELECT b.id, b.user_id, b.showtime_id, b.seat_id, b.total_price, b.status, 
                    b.booking_time, m.title, m.poster_url, s.start_time, st.seat_number,
                    s.movie_id, st.showtime_id
             FROM bookings b
             LEFT JOIN showtimes s ON b.showtime_id = s.id
             LEFT JOIN movies m ON s.movie_id = m.id
             LEFT JOIN seats st ON b.seat_id = st.id
             WHERE b.user_id = ?
             ORDER BY b.id DESC`,
            [user_id]
        );

        connection.release();
        res.status(200).json({
            user: user[0],
            tickets_count: tickets.length,
            tickets
        });
    } catch (error) {
        console.error("Lỗi debug vé:", error);
        res.status(500).json({ message: "Lỗi debug", error: error.message });
    }
};

// Kiểm tra showtimes
exports.getAllShowtimes = async (req, res) => {
    try {
        const connection = await db.getConnection();
        const [showtimes] = await connection.query(
            `SELECT s.id, s.movie_id, s.room_name, s.start_time, s.price, m.title
             FROM showtimes s
             LEFT JOIN movies m ON s.movie_id = m.id
             ORDER BY s.start_time DESC`
        );
        connection.release();
        res.status(200).json(showtimes);
    } catch (error) {
        console.error("Lỗi lấy showtimes:", error);
        res.status(500).json({ message: "Lỗi lấy showtimes", error: error.message });
    }
};

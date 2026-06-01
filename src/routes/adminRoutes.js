const express = require('express');
const router = express.Router();
const db = require('../configs/db');

const markExpiredConfirmedBookings = async () => {
    await db.query(`
        UPDATE bookings b
        JOIN showtimes s ON b.showtime_id = s.id
        JOIN movies m ON s.movie_id = m.id
        SET b.status = 'expired'
        WHERE b.status = 'confirmed'
          AND TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time) <= NOW()
    `);
};

const normalizeDateOnly = (value) => {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

// 1. Thêm phim mới
router.post('/movies/add', async (req, res) => {
    try {
        const { title, description, duration, genre, trailer_url, youtube_trailer_url, release_date, poster_url, userId } = req.body;
        const trailerUrl = youtube_trailer_url || trailer_url || "";
        const posterUrl = poster_url ? String(poster_url).trim() : null;

        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') {
            return res.status(403).json({ message: "Bạn không có quyền Admin!" });
        }

        const sql = `INSERT INTO movies (title, description, duration, genre, poster_url, trailer_url, release_date, youtube_trailer_url) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        
        await db.query(sql, [
            title || "", 
            description || "", 
            duration || 0, 
            genre || "", 
            posterUrl, 
            trailerUrl, 
            normalizeDateOnly(release_date),
            trailerUrl
        ]);
        res.status(201).json({ message: "Thêm phim thành công!" });
    } catch (err) {
        res.status(500).json({ message: "Lỗi Server: " + err.message });
    }
});

// 2. Sửa phim
router.put('/movies/edit/:id', async (req, res) => {
    try {
        const { title, description, duration, genre, trailer_url, youtube_trailer_url, release_date, poster_url, userId } = req.body;
        const trailerUrl = youtube_trailer_url || trailer_url || "";
        const { id } = req.params;

        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        const [oldMovie] = await db.query('SELECT poster_url FROM movies WHERE id = ?', [id]);
        if (!oldMovie.length) return res.status(404).json({ message: "Phim không tồn tại!" });

        const current_poster = poster_url ? String(poster_url).trim() : oldMovie[0].poster_url;

        const sql = `UPDATE movies SET title=?, description=?, duration=?, genre=?, poster_url=?, trailer_url=?, release_date=?, youtube_trailer_url=? WHERE id=?`;
        await db.query(sql, [title, description, duration, genre, current_poster, trailerUrl, normalizeDateOnly(release_date), trailerUrl, id]);
        
        res.json({ message: "Cập nhật thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 3. Xóa phim
router.delete('/movies/delete/:id', async (req, res) => {
    const { userId } = req.query;
    const movieId = req.params.id;
    
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        // Kiểm tra xem movie có tồn tại không
        const [movie] = await db.query('SELECT id FROM movies WHERE id = ?', [movieId]);
        if (!movie.length) return res.status(404).json({ message: "Phim không tồn tại!" });

        // Lấy danh sách showtimes của movie này
        const [showtimes] = await db.query('SELECT id FROM showtimes WHERE movie_id = ?', [movieId]);
        
        // Xóa dữ liệu liên quan cho từng showtime
        for (const showtime of showtimes) {
            // Xóa bookings và seats của showtime này
            await db.query('DELETE FROM bookings WHERE showtime_id = ?', [showtime.id]);
            await db.query('DELETE FROM seats WHERE showtime_id = ?', [showtime.id]);
        }
        
        // Xóa tất cả showtimes của movie này
        await db.query('DELETE FROM showtimes WHERE movie_id = ?', [movieId]);
        
        // Cuối cùng xóa movie
        await db.query('DELETE FROM movies WHERE id = ?', [movieId]);
        
        res.json({ message: "Đã xóa phim và tất cả dữ liệu liên quan!" });
    } catch (err) {
        console.error('Lỗi xóa phim:', err);
        res.status(500).json({ message: 'Lỗi xóa phim: ' + err.message });
    }
});

// CRUD Theaters
// 1. Lấy danh sách theaters
router.get('/theaters', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM theaters');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 2. Thêm theater
router.post('/theaters/add', async (req, res) => {
    const { name, capacity, userId } = req.body;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        await db.query('INSERT INTO theaters (name, capacity) VALUES (?, ?)', [name, capacity]);
        res.status(201).json({ message: "Thêm theater thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 3. Sửa theater
router.put('/theaters/edit/:id', async (req, res) => {
    const { name, capacity, userId } = req.body;
    const { id } = req.params;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        await db.query('UPDATE theaters SET name=?, capacity=? WHERE id=?', [name, capacity, id]);
        res.json({ message: "Cập nhật theater thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 4. Xóa theater
router.delete('/theaters/delete/:id', async (req, res) => {
    const { userId } = req.query;
    const theaterId = req.params.id;
    
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        // Kiểm tra xem theater có tồn tại không
        const [theater] = await db.query('SELECT id FROM theaters WHERE id = ?', [theaterId]);
        if (!theater.length) return res.status(404).json({ message: "Theater không tồn tại!" });

        // Lấy danh sách showtimes của theater này
        const [showtimes] = await db.query('SELECT id FROM showtimes WHERE theater_id = ?', [theaterId]);
        
        // Xóa dữ liệu liên quan cho từng showtime
        for (const showtime of showtimes) {
            // Xóa bookings và seats của showtime này
            await db.query('DELETE FROM bookings WHERE showtime_id = ?', [showtime.id]);
            await db.query('DELETE FROM seats WHERE showtime_id = ?', [showtime.id]);
        }
        
        // Xóa tất cả showtimes của theater này
        await db.query('DELETE FROM showtimes WHERE theater_id = ?', [theaterId]);
        
        // Cuối cùng xóa theater
        await db.query('DELETE FROM theaters WHERE id = ?', [theaterId]);
        
        res.json({ message: "Đã xóa theater và tất cả dữ liệu liên quan!" });
    } catch (err) {
        console.error('Lỗi xóa theater:', err);
        res.status(500).json({ message: 'Lỗi xóa theater: ' + err.message });
    }
});

// CRUD Showtimes
// 1. Lấy danh sách showtimes
router.get('/showtimes', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                s.id,
                s.movie_id,
                s.room_name,
                s.start_time,
                TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time) as end_time,
                s.price,
                s.theater_id,
                m.title as movie_title,
                m.duration as movie_duration,
                DATE_FORMAT(m.release_date, '%Y-%m-%d') as release_date,
                t.name as theater_name
            FROM showtimes s
            JOIN movies m ON s.movie_id = m.id
            JOIN theaters t ON s.theater_id = t.id
            ORDER BY s.start_time ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 2. Thêm showtime
router.post('/showtimes/add', async (req, res) => {
    const { movie_id, theater_id, room_name, start_time, price, userId } = req.body;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        const [movie] = await db.query("SELECT duration, DATE_FORMAT(release_date, '%Y-%m-%d') as release_date FROM movies WHERE id = ?", [movie_id]);
        if (!movie.length) return res.status(404).json({ message: "Phim không tồn tại!" });

        const showDate = String(start_time).slice(0, 10);
        if (movie[0].release_date && showDate < movie[0].release_date) {
            return res.status(400).json({ message: "Ngày chiếu không được trước ngày khởi chiếu của phim!" });
        }

        const duration = Number(movie[0].duration) || 0;
        const [result] = await db.query(
            'INSERT INTO showtimes (movie_id, theater_id, room_name, start_time, end_time, price) VALUES (?, ?, ?, ?, DATE_ADD(?, INTERVAL ? MINUTE), ?)',
            [movie_id, theater_id, room_name, start_time, start_time, duration, price]
        );

        const showtimeId = result.insertId;
        const [theater] = await db.query('SELECT capacity FROM theaters WHERE id = ?', [theater_id]);
        if (theater.length) {
            const capacity = theater[0].capacity;
            const seats = [];
            
            // Tạo layout rạp phim thực tế (hàng A, B, C... với số ghế mỗi hàng)
            const seatsPerRow = 10; // 10 ghế mỗi hàng
            const numRows = Math.ceil(capacity / seatsPerRow);
            const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            
            let seatCount = 0;
            for (let row = 0; row < numRows && seatCount < capacity; row++) {
                const rowLetter = rowLetters[row];
                const seatsInThisRow = Math.min(seatsPerRow, capacity - seatCount);
                
                for (let seat = 1; seat <= seatsInThisRow; seat++) {
                    seats.push([showtimeId, `${rowLetter}${seat}`, false]);
                    seatCount++;
                }
            }
            
            await db.query('INSERT INTO seats (showtime_id, seat_number, is_booked) VALUES ?', [seats]);
        }

        res.status(201).json({ message: "Thêm showtime thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 3. Sửa showtime
router.put('/showtimes/edit/:id', async (req, res) => {
    const { movie_id, theater_id, room_name, start_time, price, userId } = req.body;
    const { id } = req.params;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        const [movie] = await db.query("SELECT duration, DATE_FORMAT(release_date, '%Y-%m-%d') as release_date FROM movies WHERE id = ?", [movie_id]);
        if (!movie.length) return res.status(404).json({ message: "Phim không tồn tại!" });

        const showDate = String(start_time).slice(0, 10);
        if (movie[0].release_date && showDate < movie[0].release_date) {
            return res.status(400).json({ message: "Ngày chiếu không được trước ngày khởi chiếu của phim!" });
        }

        const duration = Number(movie[0].duration) || 0;
        await db.query(
            'UPDATE showtimes SET movie_id=?, theater_id=?, room_name=?, start_time=?, end_time=DATE_ADD(?, INTERVAL ? MINUTE), price=? WHERE id=?',
            [movie_id, theater_id, room_name, start_time, start_time, duration, price, id]
        );
        res.json({ message: "Cập nhật showtime thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 4. Xóa showtime
router.delete('/showtimes/delete/:id', async (req, res) => {
    const { userId } = req.query;
    const showtimeId = req.params.id;
    
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        // Kiểm tra xem showtime có tồn tại không
        const [showtime] = await db.query('SELECT id FROM showtimes WHERE id = ?', [showtimeId]);
        if (!showtime.length) return res.status(404).json({ message: "Showtime không tồn tại!" });

        // Xóa dữ liệu liên quan theo thứ tự để tránh lỗi foreign key
        // 1. Xóa bookings liên quan đến showtime này
        await db.query('DELETE FROM bookings WHERE showtime_id = ?', [showtimeId]);
        
        // 2. Xóa seats liên quan đến showtime này
        await db.query('DELETE FROM seats WHERE showtime_id = ?', [showtimeId]);
        
        // 3. Cuối cùng xóa showtime
        await db.query('DELETE FROM showtimes WHERE id = ?', [showtimeId]);
        
        res.json({ message: "Đã xóa showtime và tất cả dữ liệu liên quan!" });
    } catch (err) {
        console.error('Lỗi xóa showtime:', err);
        res.status(500).json({ message: 'Lỗi xóa showtime: ' + err.message });
    }
});

// CRUD Seats
// 1. Lấy seats theo showtime
router.get('/seats/showtime/:showtimeId', async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM seats WHERE showtime_id = ?', [showtimeId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 2. Tạo seats cho showtime dựa trên capacity phòng chiếu
router.post('/seats/generate/showtime/:showtimeId', async (req, res) => {
    const { showtimeId } = req.params;
    const { userId, numberOfSeats } = req.body;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        const [showtime] = await db.query('SELECT theater_id FROM showtimes WHERE id = ?', [showtimeId]);
        if (!showtime.length) return res.status(404).json({ message: "Showtime không tồn tại!" });

        const [theater] = await db.query('SELECT capacity FROM theaters WHERE id = ?', [showtime[0].theater_id]);
        if (!theater.length) return res.status(404).json({ message: "Theater không tồn tại!" });

        const capacity = theater[0].capacity;
        const seatsToAdd = numberOfSeats || capacity;
        
        // Kiểm tra không vượt quá sức chứa
        if (seatsToAdd > capacity) {
            return res.status(400).json({ message: `Không thể thêm quá ${capacity} ghế (sức chứa phòng)!` });
        }
        
        // Lấy số ghế hiện tại
        const [existingSeats] = await db.query('SELECT COUNT(*) as count FROM seats WHERE showtime_id = ?', [showtimeId]);
        const currentCount = existingSeats[0].count;
        
        if (currentCount + seatsToAdd > capacity) {
            return res.status(400).json({ message: `Chỉ có thể thêm ${capacity - currentCount} ghế nữa!` });
        }
        
        // Lấy ghế cao nhất hiện tại để tiếp tục từ đó
        let nextSeatNumber = currentCount + 1;
        const seats = [];
        
        // Tạo layout rạp phim thực tế (hàng A, B, C... với số ghế mỗi hàng)
        const seatsPerRow = 10;
        const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        
        for (let i = 0; i < seatsToAdd; i++) {
            const rowIndex = Math.floor((nextSeatNumber - 1) / seatsPerRow);
            const seatIndex = ((nextSeatNumber - 1) % seatsPerRow) + 1;
            const rowLetter = rowLetters[rowIndex];
            
            if (rowIndex >= rowLetters.length) {
                return res.status(400).json({ message: `Vượt quá giới hạn số hàng ghế!` });
            }
            
            seats.push([showtimeId, `${rowLetter}${seatIndex}`, false]);
            nextSeatNumber++;
        }
        
        await db.query('INSERT INTO seats (showtime_id, seat_number, is_booked) VALUES ?', [seats]);
        res.status(201).json({ message: `Đã thêm ${seatsToAdd} ghế thành công! Tổng cộng: ${currentCount + seatsToAdd} ghế.` });
    } catch (err) {
        console.error('Lỗi thêm ghế:', err);
        res.status(500).json({ message: 'Lỗi thêm ghế: ' + err.message });
    }
});

// 3. Cập nhật trạng thái ghế
router.put('/seats/edit/:id', async (req, res) => {
    const { is_booked, userId } = req.body;
    const { id } = req.params;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        await db.query('UPDATE seats SET is_booked=? WHERE id=?', [is_booked ? 1 : 0, id]);
        res.json({ message: "Cập nhật ghế thành công!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 4. Xóa tất cả ghế của một showtime
router.delete('/seats/deleteAll/showtime/:showtimeId', async (req, res) => {
    const { showtimeId } = req.params;
    const { userId } = req.query;
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        // Xóa bookings liên quan đến các ghế của showtime này
        await db.query(`
            DELETE FROM bookings 
            WHERE seat_id IN (SELECT id FROM seats WHERE showtime_id = ?)
        `, [showtimeId]);
        
        // Xóa tất cả ghế của showtime
        await db.query('DELETE FROM seats WHERE showtime_id = ?', [showtimeId]);
        
        res.json({ message: "Đã xóa tất cả ghế thành công!" });
    } catch (err) {
        console.error('Lỗi xóa ghế:', err);
        res.status(500).json({ message: 'Lỗi xóa ghế: ' + err.message });
    }
});

// 4. Xóa số lượng ghế cụ thể của một showtime (xóa từ cuối)
router.delete('/seats/delete/showtime/:showtimeId', async (req, res) => {
    const { showtimeId } = req.params;
    const { userId, count } = req.query;
    const seatsToDelete = parseInt(count) || 1;
    
    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        // Lấy tổng số ghế hiện tại
        const [seatCount] = await db.query('SELECT COUNT(*) as count FROM seats WHERE showtime_id = ?', [showtimeId]);
        const currentCount = seatCount[0].count;
        
        if (seatsToDelete > currentCount) {
            return res.status(400).json({ message: `Chỉ có ${currentCount} ghế, không thể xóa ${seatsToDelete} ghế!` });
        }
        
        // Lấy các ghế từ cuối để xóa
        const [seatsToRemove] = await db.query(`
            SELECT id FROM seats 
            WHERE showtime_id = ? 
            ORDER BY id DESC 
            LIMIT ?
        `, [showtimeId, seatsToDelete]);
        
        const seatIds = seatsToRemove.map(s => s.id);
        
        if (seatIds.length > 0) {
            // Xóa bookings liên quan
            await db.query(`DELETE FROM bookings WHERE seat_id IN (${seatIds.map(() => '?').join(',')})`, seatIds);
            
            // Xóa ghế
            await db.query(`DELETE FROM seats WHERE id IN (${seatIds.map(() => '?').join(',')})`, seatIds);
        }
        
        res.json({ message: `Đã xóa ${seatsToDelete} ghế thành công! Còn lại: ${currentCount - seatsToDelete} ghế.` });
    } catch (err) {
        console.error('Lỗi xóa ghế:', err);
        res.status(500).json({ message: 'Lỗi xóa ghế: ' + err.message });
    }
});

// Admin view revenue statistics
router.get('/statistics', async (req, res) => {
    try {
        await markExpiredConfirmedBookings();
        const { from_date, to_date } = req.query;
        const dateFilter = [];
        let whereClause = '';

        if (from_date && to_date) {
            whereClause = 'AND DATE(sh.start_time) BETWEEN ? AND ?';
            dateFilter.push(from_date, to_date);
        } else if (from_date) {
            whereClause = 'AND DATE(sh.start_time) >= ?';
            dateFilter.push(from_date);
        } else if (to_date) {
            whereClause = 'AND DATE(sh.start_time) <= ?';
            dateFilter.push(to_date);
        }

        const [summary] = await db.query(`
            SELECT
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN b.total_price ELSE 0 END), 0) AS total_revenue,
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN 1 ELSE 0 END), 0) AS tickets_sold,
                COALESCE(SUM(CASE WHEN b.status = 'expired' THEN b.total_price ELSE 0 END), 0) AS expired_revenue,
                COALESCE(SUM(CASE WHEN b.status = 'expired' THEN 1 ELSE 0 END), 0) AS expired_tickets,
                COALESCE(SUM(CASE WHEN b.status = 'pending' THEN b.total_price ELSE 0 END), 0) AS pending_revenue,
                COALESCE(SUM(CASE WHEN b.status = 'cancel' THEN b.total_price ELSE 0 END), 0) AS canceled_revenue
            FROM bookings b
            JOIN showtimes sh ON b.showtime_id = sh.id
            WHERE 1 = 1 ${whereClause}
        `, dateFilter);

        const [revenueByShowtime] = await db.query(`
            SELECT
                sh.id AS showtime_id,
                sh.room_name,
                t.name AS theater_name,
                m.title AS movie_title,
                sh.start_time,
                sh.price,
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN b.total_price ELSE 0 END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN 1 ELSE 0 END), 0) AS tickets_sold
            FROM showtimes sh
            JOIN movies m ON sh.movie_id = m.id
            JOIN theaters t ON sh.theater_id = t.id
            LEFT JOIN bookings b ON b.showtime_id = sh.id
            WHERE 1 = 1 ${whereClause}
            GROUP BY sh.id
            ORDER BY revenue DESC, tickets_sold DESC
            LIMIT 30
        `, dateFilter);

        const [revenueByTheater] = await db.query(`
            SELECT
                t.id AS theater_id,
                t.name AS theater_name,
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN b.total_price ELSE 0 END), 0) AS revenue,
                COALESCE(COUNT(CASE WHEN b.status IN ('confirmed', 'expired') THEN 1 END), 0) AS tickets_sold
            FROM theaters t
            LEFT JOIN showtimes sh ON sh.theater_id = t.id
            LEFT JOIN bookings b ON b.showtime_id = sh.id
            WHERE 1 = 1 ${whereClause}
            GROUP BY t.id
            ORDER BY revenue DESC
        `, dateFilter);

        const [revenueByMovie] = await db.query(`
            SELECT
                m.id AS movie_id,
                m.title AS movie_title,
                COALESCE(SUM(CASE WHEN b.status IN ('confirmed', 'expired') THEN b.total_price ELSE 0 END), 0) AS revenue,
                COALESCE(COUNT(CASE WHEN b.status IN ('confirmed', 'expired') THEN 1 END), 0) AS tickets_sold
            FROM movies m
            LEFT JOIN showtimes sh ON sh.movie_id = m.id
            LEFT JOIN bookings b ON b.showtime_id = sh.id
            WHERE 1 = 1 ${whereClause}
            GROUP BY m.id
            ORDER BY revenue DESC
        `, dateFilter);

        // Biểu đồ theo ngày ĐẶT VÉ (booking_time), không phải ngày chiếu
        const bookingDateParams = [];
        let bookingDateWhere = "WHERE b.status IN ('confirmed', 'expired')";
        if (from_date && to_date) {
            bookingDateWhere += ' AND DATE(b.booking_time) BETWEEN ? AND ?';
            bookingDateParams.push(from_date, to_date);
        } else if (from_date) {
            bookingDateWhere += ' AND DATE(b.booking_time) >= ?';
            bookingDateParams.push(from_date);
        } else if (to_date) {
            bookingDateWhere += ' AND DATE(b.booking_time) <= ?';
            bookingDateParams.push(to_date);
        }

        const [revenueByDate] = await db.query(`
            SELECT
                DATE(b.booking_time) AS date,
                COALESCE(SUM(b.total_price), 0) AS revenue,
                COALESCE(COUNT(*), 0) AS orders
            FROM bookings b
            ${bookingDateWhere}
            GROUP BY DATE(b.booking_time)
            ORDER BY DATE(b.booking_time)
        `, bookingDateParams);

        const totalRevenue = summary[0]?.total_revenue || 0;
        const ticketsSold = summary[0]?.tickets_sold || 0;

        res.json({
            total_revenue: totalRevenue,
            tickets_sold: ticketsSold,
            expired_revenue: summary[0]?.expired_revenue || 0,
            expired_tickets: summary[0]?.expired_tickets || 0,
            pending_revenue: summary[0]?.pending_revenue || 0,
            canceled_revenue: summary[0]?.canceled_revenue || 0,
            average_ticket_value: ticketsSold ? Number((totalRevenue / ticketsSold).toFixed(2)) : 0,
            revenue_by_showtime: revenueByShowtime,
            revenue_by_theater: revenueByTheater,
            revenue_by_movie: revenueByMovie,
            revenue_by_date: revenueByDate,
            date_range: { from_date, to_date }
        });
    } catch (err) {
        console.error('Lỗi thống kê doanh thu:', err);
        res.status(500).json({ message: err.message });
    }
});

// Admin view bookings
router.get('/bookings', async (req, res) => {
    try {
        await markExpiredConfirmedBookings();
        const [rows] = await db.query(`
            SELECT
                b.*,
                u.fullname AS username,
                s.seat_number,
                sh.start_time,
                TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), sh.start_time) as end_time,
                m.title as movie_title,
                t.name as theater_name
            FROM bookings b
            JOIN users u ON b.user_id = u.id
            JOIN seats s ON b.seat_id = s.id
            JOIN showtimes sh ON s.showtime_id = sh.id
            JOIN movies m ON sh.movie_id = m.id
            JOIN theaters t ON sh.theater_id = t.id
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/bookings/confirm/:id', async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    try {
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') return res.status(403).json({ message: "Từ chối!" });

        const [result] = await db.query(
            "UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'pending'",
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(400).json({ message: "Vé không ở trạng thái chờ xác nhận." });
        }

        res.json({ message: "Đã xác nhận thanh toán vé." });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Làm sạch dữ liệu status không hợp lệ
router.post('/cleanup-invalid-status', async (req, res) => {
    const { userId } = req.body;
    try {
        // Kiểm tra quyền admin
        const [user] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (!user.length || user[0].role !== 'admin') {
            return res.status(403).json({ message: "Từ chối!" });
        }

        // Chuyển các status cũ sang format mới
        const [result] = await db.query(`
            UPDATE bookings 
            SET status = 'cancel' 
            WHERE status = 'cancelled'
        `);

        res.json({ 
            message: `Đã làm sạch ${result.affectedRows} vé có status không hợp lệ.`,
            affectedRows: result.affectedRows
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
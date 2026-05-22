const db = require('../configs/db');

exports.createShowtime = async (req, res) => {
    // rows và cols là số hàng/cột do Admin nhập từ giao diện
    const { movie_id, room_name, start_time, end_time, price, rows, cols } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction(); // Dùng Transaction để đảm bảo an toàn dữ liệu

        // Bước 1: Thêm suất chiếu vào bảng 'showtimes'
        const [showtimeResult] = await connection.query(
            'INSERT INTO showtimes (movie_id, room_name, start_time, end_time, price) VALUES (?, ?, ?, ?, ?)',
            [movie_id, room_name, start_time, end_time || null, price]
        );
        const showtimeId = showtimeResult.insertId;

        // Bước 2: Tự động tạo mảng dữ liệu ghế (Ví dụ: A1, A2... B1, B2...)
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        let seats = [];
        for (let i = 0; i < rows; i++) {
            for (let j = 1; j <= cols; j++) {
                const seatNumber = `${alphabet[i]}${j}`;
                // Cấu trúc mảng trùng với các cột: showtime_id, seat_number, is_booked
                seats.push([showtimeId, seatNumber, false]);
            }
        }

        // Bước 3: Lưu hàng loạt ghế vào bảng 'seats' chỉ với 1 câu lệnh SQL
        const query = 'INSERT INTO seats (showtime_id, seat_number, is_booked) VALUES ?';
        await connection.query(query, [seats]);

        await connection.commit(); // Xác nhận hoàn tất
        res.status(201).json({ message: "Đã tạo suất chiếu và sơ đồ ghế tự động!" });

    } catch (error) {
        await connection.rollback(); // Nếu lỗi thì hủy bỏ toàn bộ để tránh dữ liệu rác
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};
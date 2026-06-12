const db = require('../configs/db');

const movieSelectFields = `
    id,
    title,
    description,
    duration,
    genre,
    poster_url,
    trailer_url,
    DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date,
    youtube_trailer_url
`;

// 1. Lấy toàn bộ danh sách phim (Dùng cho Trang chủ)
exports.getAllMovies = async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT ${movieSelectFields} FROM movies ORDER BY id ASC`);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi server', error: err.message });
    }
};

// 2. Lấy chi tiết 1 bộ phim (Dùng cho Trang MovieDetail)
exports.getMovieById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(`SELECT ${movieSelectFields} FROM movies WHERE id = ?`, [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phim' });
        }
        res.status(200).json(rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy thông tin phim', error: err.message });
    }
};

// 3. Lấy danh sách suất chiếu của 1 bộ phim (Dùng cho Trang MovieDetail)
exports.getShowtimesByMovie = async (req, res) => {
    const { id } = req.params; // id của phim
    try {
        const [rows] = await db.query(`
            SELECT
                s.id,
                s.movie_id,
                s.room_name,
                DATE_FORMAT(s.start_time, '%Y-%m-%d %H:%i:%s') as start_time,
                DATE_FORMAT(TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time), '%Y-%m-%d %H:%i:%s') as end_time,
                s.price,
                s.theater_id,
                t.name as theater_name
            FROM showtimes s 
            JOIN movies m ON s.movie_id = m.id
            JOIN theaters t ON s.theater_id = t.id 
            WHERE s.movie_id = ? 
            ORDER BY s.start_time ASC
        `, [id]);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy suất chiếu', error: err.message });
    }
};

// 4. Lấy danh sách ghế của 1 suất chiếu (Dùng cho Trang SeatSelection)
exports.getSeatsByShowtime = async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const [seats] = await db.query(
            'SELECT * FROM seats WHERE showtime_id = ?', 
            [showtimeId]
        );
        res.json(seats);
    } catch (error) {
        res.status(500).json({ message: "Lỗi lấy danh sách ghế" });
    }
};

// 5. Lấy thông tin cụ thể của 1 suất chiếu (Để hiện tên phòng, giá vé trên trang chọn ghế)
exports.getShowtimeDetail = async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT
                s.id,
                s.movie_id,
                s.room_name,
                DATE_FORMAT(s.start_time, '%Y-%m-%d %H:%i:%s') as start_time,
                DATE_FORMAT(TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time), '%Y-%m-%d %H:%i:%s') as end_time,
                s.price,
                s.theater_id,
                m.title,
                m.duration,
                t.name as theater_name 
             FROM showtimes s 
             JOIN movies m ON s.movie_id = m.id 
             JOIN theaters t ON s.theater_id = t.id 
             WHERE s.id = ?
        `, [showtimeId]);
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ message: "Lỗi lấy thông tin suất chiếu" });
    }
};

// 6. Lấy phim sắp chiếu trong 7 ngày tới (Dùng cho Trang chủ)
exports.getUpcomingMovies = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const sevenDaysLater = new Date(today);
        sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
        
        const [rows] = await db.query(
            `SELECT ${movieSelectFields} FROM movies 
             WHERE release_date > CURDATE() AND release_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
             ORDER BY release_date ASC`
        );
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy phim sắp chiếu', error: err.message });
    }
};

const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Các biến phục vụ Caching toàn cục (Giúp giảm tải DB khi nhiều người truy vấn liên tục)
let cachedMovieContext = null;
let lastMovieCacheTime = 0;
const MOVIE_CACHE_TTL = 15 * 60 * 1000; // Cache danh sách phim trong 15 phút

let cachedShowtimeContext = null;
let lastShowtimeCacheTime = 0;
const SHOWTIME_CACHE_TTL = 2 * 60 * 1000; // Cache lịch chiếu/giá vé trong 2 phút (để cập nhật vé/giờ liên tục)

const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (err) {
        console.error('DB query error:', err);
        return null;
    }
};

// POST /api/ai/chat
exports.chatWithAI = async (req, res) => {
    const { userId, userMessage, mode = 'short' } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    try {
        const now = Date.now();

        // 1. TỐI ƯU CACHE DANH SÁCH PHIM (Tránh quét DB liên tục)
        if (!cachedMovieContext || (now - lastMovieCacheTime > MOVIE_CACHE_TTL)) {
            const movies = await safeQuery('SELECT id, title, genre, description FROM movies LIMIT 50') || [];
            cachedMovieContext = movies.map(m => `- ${m.title} (${m.genre}): ${m.description}`).join('\n');
            lastMovieCacheTime = now;
        }

        // 2. SỬA LỖI GIÁ VÉ: CACHE LỊCH CHIẾU & GIÁ VÉ THỰC TẾ TỪ DB
        if (!cachedShowtimeContext || (now - lastShowtimeCacheTime > SHOWTIME_CACHE_TTL)) {
            const showtimes = await safeQuery(`
                SELECT s.movie_id, m.title, s.start_time, s.price, s.hall, s.available_seats
                FROM showtimes s
                JOIN movies m ON s.movie_id = m.id
                WHERE s.start_time >= NOW()
                ORDER BY s.start_time
                LIMIT 100
            `) || [];
            
            cachedShowtimeContext = showtimes.map(s => {
                const timeStr = new Date(s.start_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                return `- Phim "${s.title}": Suất chiếu lúc ${timeStr} | Phòng: ${s.hall} | Giá vé gốc: ${Number(s.price).toLocaleString('vi-VN')} VNĐ | Còn ${s.available_seats} ghế`;
            }).join('\n');
            lastShowtimeCacheTime = now;
        }

        let prefText = '';
        let bookingText = '';

        // 3. TỐI ƯU HIỆU NĂNG: CHẠY SONG SONG CÁC TRUY VẤN CỦA USER BẰNG Promise.all
        if (userId) {
            const [prefs, history] = await Promise.all([
                safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]),
                safeQuery(`
                    SELECT m.title, m.genre, b.status, b.booking_time
                    FROM bookings b
                    JOIN showtimes s ON b.showtime_id = s.id
                    JOIN movies m ON s.movie_id = m.id
                    WHERE b.user_id = ?
                    ORDER BY b.booking_time DESC
                    LIMIT 10
                `, [userId])
            ]);

            if (prefs && prefs.length > 0) {
                const p = prefs[0];
                prefText = `User preferences: genres=${p.genres || ''}; language=${p.language || ''}; seat=${p.seat_pref || ''}`;
            }

            if (history && history.length > 0) {
                bookingText = 'Recent bookings:\n' + history.map(h => `- ${h.title} (${h.genre}) status=${h.status}`).join('\n');
            }
        }

        // 4. THIẾT LẬP CÂU LỆNH HỆ THỐNG NGHIÊM NGẶT (Ràng buộc dữ liệu giá vé)
        const systemInstruction = `Bạn là trợ lý ảo cho rạp phim TTV. Trả lời thân thiện, chính xác trong phạm vi rạp phim.
Dựa TUYỆT ĐỐI vào dữ liệu thực tế được cung cấp bên dưới để trả lời về giá vé, giờ chiếu và thông tin phim. 
NẾU dữ liệu bên dưới không có thông tin về bộ phim hoặc giá vé mà người dùng hỏi, hãy lịch sự thông báo "Hiện tại phim này chưa có lịch chiếu hoặc giá vé cụ thể, bạn vui lòng theo dõi thêm trên website nhé!". 
TUYỆT ĐỐI KHÔNG TỰ BỊA ĐẶT (NÓI PHÉT) RA GIÁ VÉ HOẶC GIỜ CHIẾU KHÔNG CÓ TRONG CONTEXT.

${prefText}
${bookingText}

Danh sách phim hiện có:
${cachedMovieContext}

Lịch chiếu và Giá vé thực tế hiện tại:
${cachedShowtimeContext || '- Hiện tại hệ thống chưa cập nhật lịch chiếu mới.'}

Hãy trả lời ngắn gọn, chính xác theo dữ liệu và format cách dòng cho đẹp mắt.`;

        // 5. GỌI GEMINI API XỬ LÝ PROMPT
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction
        });

        const result = await model.generateContent(userMessage);
        const aiReply = result?.response?.text ? result.response.text() : 'Xin lỗi, tôi không thể trả lời lúc này.';

        // 6. TỐI ƯU HOÀN TOÀN: LƯU LOG BẤT ĐỒNG BỘ (FIRE-AND-FORGET)
        // Không dùng 'await' ở đây, giúp trả kết quả về cho client ngay lập tức mà không bị block bởi DB write
        db.query('INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)', 
            [userId || null, userMessage, aiReply, JSON.stringify({ mode })]
        ).catch(e => {
            console.warn('Không thể lưu tương tác AI:', e.message);
        });

        // Trả phản hồi ngay cho người dùng
        res.json({ reply: aiReply });

    } catch (error) {
        console.error('Lỗi chatWithAI:', error);
        res.status(500).json({ reply: 'Hệ thống AI đang bảo trì, bạn thử lại sau nhé!' });
    }
};

// GET /api/ai/preferences/:userId
exports.getPreferences = async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const rows = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
    if (!rows) return res.status(500).json({ error: 'DB error' });
    res.json(rows[0] || {});
};

// PUT /api/ai/preferences/:userId
exports.updatePreferences = async (req, res) => {
    const { userId } = req.params;
    const { genres = '', language = 'vi', seat_pref = '' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        await db.query(`
            INSERT INTO user_preferences (user_id, genres, language, seat_pref)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE genres = VALUES(genres), language = VALUES(language), seat_pref = VALUES(seat_pref)
        `, [userId, genres, language, seat_pref]);

        res.json({ ok: true });
    } catch (err) {
        console.error('Lỗi updatePreferences:', err);
        res.status(500).json({ error: 'DB error' });
    }
};

// GET /api/ai/recommendations/:userId (Đã được tối ưu Promise.all)
exports.recommendations = async (req, res) => {
    const { userId } = req.params;
    try {
        // Tối ưu chạy song song 3 câu lệnh lấy dữ liệu để tính score
        const [prefs, moviesResult, bookedResult] = await Promise.all([
            userId ? safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]) : Promise.resolve(null),
            safeQuery('SELECT id, title, genre, poster_url FROM movies'),
            userId ? safeQuery(`SELECT DISTINCT m.id FROM bookings b JOIN showtimes s ON b.showtime_id = s.id JOIN movies m ON s.movie_id = m.id WHERE b.user_id = ?`, [userId]) : Promise.resolve([])
        ]);

        const prefGenres = prefs && prefs[0] && prefs[0].genres ? prefs[0].genres.split(',').map(s => s.trim().toLowerCase()) : [];
        const movies = moviesResult || [];
        const bookedIds = new Set((bookedResult || []).map(r => r.id));

        // Tính điểm gợi ý phim
        const scored = movies.map(m => {
            let score = 0;
            const genres = (m.genre || '').toLowerCase().split(',').map(s => s.trim());
            if (prefGenres.length && genres.some(g => prefGenres.includes(g))) score += 10;
            if (!bookedIds.has(m.id)) score += 5;
            return { id: m.id, title: m.title, poster_url: m.poster_url, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 8).map(s => ({ id: s.id, title: s.title, poster_url: s.poster_url, reason: `Matches your preferences` }));
        res.json({ recommendations: top });
    } catch (err) {
        console.error('Lỗi recommendations:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// GET /api/ai/logs
exports.getLogs = async (req, res) => {
    try {
        const rows = await safeQuery('SELECT id, user_id, user_query, ai_response, meta, created_at FROM ai_interactions ORDER BY created_at DESC LIMIT 200');
        res.json({ logs: rows || [] });
    } catch (err) {
        console.error('Lỗi getLogs:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// GET /api/ai/showtimes?movieId=123
exports.getShowtimesForAI = async (req, res) => {
    const { movieId } = req.query;
    if (!movieId) return res.status(400).json({ error: 'movieId is required' });

    try {
        const rows = await safeQuery(`
            SELECT s.id, s.movie_id, s.start_time, s.price, s.available_seats, s.hall
            FROM showtimes s
            WHERE s.movie_id = ?
            AND (s.start_time IS NULL OR s.start_time >= NOW())
            ORDER BY s.start_time
            LIMIT 100
        `, [movieId]);

        if (rows === null) return res.status(500).json({ error: 'DB error' });
        res.json({ showtimes: rows });
    } catch (err) {
        console.error('Lỗi getShowtimesForAI:', err);
        res.status(500).json({ error: 'Server error' });
    }
};
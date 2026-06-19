const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


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
        // 1. Lấy danh sách phim hiện có
        const movies = await safeQuery('SELECT id, title, genre, description FROM movies LIMIT 50') || [];
        
        // 2. Lấy danh sách tất cả suất chiếu sắp diễn ra để AI biết thông tin lịch chiếu & giá vé
        const showtimes = await safeQuery(`
            SELECT movie_id, start_time, price, available_seats, hall
            FROM showtimes
            WHERE start_time >= NOW()
            ORDER BY start_time ASC
        `) || [];

        // Gom nhóm các suất chiếu theo movie_id để dễ map vào danh sách phim
        const showtimesMap = {};
        showtimes.forEach(s => {
            if (!showtimesMap[s.movie_id]) {
                showtimesMap[s.movie_id] = [];
            }
            // Định dạng thời gian cho AI dễ đọc hiểu (Ví dụ: 12:19 20/06)
            const timeStr = s.start_time 
                ? new Date(s.start_time).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) 
                : 'Chưa rõ';
            
            showtimesMap[s.movie_id].push(`+ Suất: ${timeStr} | Giá vé: ${s.price.toLocaleString('vi-VN')}đ | Phòng: ${s.hall} (Còn ${s.available_seats} ghế)`);
        });

        // 3. Kết hợp thông tin phim và lịch chiếu/giá vé vào movieContext
        const movieContext = movies.map(m => {
            const listShowtimes = showtimesMap[m.id] && showtimesMap[m.id].length > 0
                ? showtimesMap[m.id].join('\n    ')
                : '+ Hiện tại chưa có suất chiếu tiếp theo hoặc đã hết vé.';
            
            return `- Tên phim: ${m.title} (${m.genre})\n  Mô tả: ${m.description}\n  Lịch chiếu & Giá vé:\n    ${listShowtimes}`;
        }).join('\n\n');

        // Lấy thông tin sở thích người dùng (nếu có)
        let prefText = '';
        if (userId) {
            const prefs = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
            if (prefs && prefs.length > 0) {
                const p = prefs[0];
                prefText = `User preferences: genres=${p.genres || ''}; language=${p.language || ''}; seat=${p.seat_pref || ''}`;
            }
        }

        // Lấy lịch sử đặt vé gần đây (nếu có)
        let bookingText = '';
        if (userId) {
            const history = await safeQuery(`
                SELECT m.title, m.genre, b.status, b.booking_time
                FROM bookings b
                JOIN showtimes s ON b.showtime_id = s.id
                JOIN movies m ON s.movie_id = m.id
                WHERE b.user_id = ?
                ORDER BY b.booking_time DESC
                LIMIT 10
            `, [userId]);
            if (history && history.length) {
                bookingText = 'Recent bookings:\n' + history.map(h => `- ${h.title} (${h.genre}) status=${h.status}`).join('\n');
            }
        }

        // 4. Cập nhật System Instruction yêu cầu AI sử dụng dữ liệu vừa map để trả lời khách hàng
        const systemInstruction = `Bạn là trợ lý ảo cho rạp phim TTV. Trả lời thân thiện, chính xác trong phạm vi rạp phim. Hãy sử dụng thông tin về phim, lịch chiếu và giá vé được cung cấp bên dưới để trả lời chi tiết và chính xác cho người dùng. Các câu hỏi ngoài phạm vi rạp phim thì từ chối trả lời lịch sự.\n${prefText}\n${bookingText}\nDanh sách phim kèm lịch chiếu và giá vé hiện có:\n${movieContext}\nHãy trả lời ngắn gọn, rõ ràng và tự động xuống dòng, phân tách các ý cho đẹp mắt, dễ đọc.`;

        // Gọi Gemini API tương tác
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction
        });

        const prompt = userMessage;
        const result = await model.generateContent(prompt);
        const aiReply = result?.response?.text ? result.response.text() : 'Xin lỗi, tôi không thể trả lời lúc này.';

        // Lưu log tương tác AI
        try {
            await db.query('INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)', [userId || null, userMessage, aiReply, JSON.stringify({ mode })]);
        } catch (e) {
            console.warn('Không thể lưu tương tác AI:', e.message);
        }

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
        // Upsert behavior
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

// GET /api/ai/recommendations/:userId
exports.recommendations = async (req, res) => {
    const { userId } = req.params;
    try {
        // Basic heuristic: prefer user's genres and not-yet-seen movies
        let prefs = null;
        if (userId) prefs = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
        const prefGenres = prefs && prefs[0] && prefs[0].genres ? prefs[0].genres.split(',').map(s => s.trim().toLowerCase()) : [];

        // Movies and booking history
        const movies = await safeQuery('SELECT id, title, genre, poster_url FROM movies');
        const booked = userId ? await safeQuery(`SELECT DISTINCT m.id FROM bookings b JOIN showtimes s ON b.showtime_id = s.id JOIN movies m ON s.movie_id = m.id WHERE b.user_id = ?`, [userId]) : [];
        const bookedIds = new Set((booked || []).map(r => r.id));

        // Score movies
        const scored = (movies || []).map(m => {
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
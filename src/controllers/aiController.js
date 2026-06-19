const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache toàn cục chống nghẽn DB
let cachedMovieContext = null;
let lastMovieCacheTime = 0;
const MOVIE_CACHE_TTL = 15 * 60 * 1000; // 15 phút

let cachedShowtimeContext = null;
let lastShowtimeCacheTime = 0;
const SHOWTIME_CACHE_TTL = 2 * 60 * 1000; // 2 phút

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

        // 1. LẤY DANH SÁCH PHIM (Có cache)
        if (!cachedMovieContext || (now - lastMovieCacheTime > MOVIE_CACHE_TTL)) {
            const movies = await safeQuery('SELECT id, title, genre, description FROM movies LIMIT 50') || [];
            cachedMovieContext = movies.map(m => `- ${m.title} (${m.genre}): ${m.description}`).join('\n');
            lastMovieCacheTime = now;
        }

        // 2. SỬA LỖI GIÁ VÉ/LỊCH CHIẾU: Ép cứng múi giờ Việt Nam bẻ gãy lỗi lệch giờ server
        if (!cachedShowtimeContext || (now - lastShowtimeCacheTime > SHOWTIME_CACHE_TTL)) {
            // Lấy ngày hôm nay định dạng YYYY-MM-DD theo đúng giờ Việt Nam (GMT+7)
            const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

            // Thay vì dùng NOW(), dùng DATE(s.start_time) >= ? để lấy toàn bộ lịch chiếu từ hôm nay trở đi
            const showtimes = await safeQuery(`
                SELECT s.movie_id, m.title, s.start_time, s.price, s.hall, s.available_seats
                FROM showtimes s
                JOIN movies m ON s.movie_id = m.id
                WHERE DATE(s.start_time) >= ?
                ORDER BY s.start_time ASC
                LIMIT 150
            `, [todayVN]) || [];
            
            cachedShowtimeContext = showtimes.map(s => {
                const timeStr = new Date(s.start_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                return `- Phim "${s.title}": Suất chiếu lúc ${timeStr} | Phòng: ${s.hall} | Giá vé: ${Number(s.price).toLocaleString('vi-VN')} VNĐ | Còn ${s.available_seats} ghế`;
            }).join('\n');
            
            lastShowtimeCacheTime = now;
        }

        let prefText = '';
        let bookingText = '';

        // 3. TỐI ƯU SONG SONG: Lấy thông tin user cùng lúc
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

        // 4. NÂNG CẤP SYSTEM INSTRUCTION: Thiết lập kỷ luật tối đa cho AI
            let systemInstruction = `Bạn là trợ lý AI thông minh của rạp phim TTV. Trả lời thân thiện, ngắn gọn, chính xác.
    Chỉ hỗ trợ: tư vấn phim, đặt vé, suất chiếu, giá vé. Web chưa có hệ thống giảm giá voucher. Câu hỏi ngoài phạm vi rạp phim thì từ chối lịch sự.

    QUY TẮC QUAN TRỌNG VỀ TRA CỨU SUẤT CHIẾU VÀ GIÁ VÉ:
    - Khi khách hàng hỏi về giá vé, suất chiếu, lịch chiếu hoặc phòng chiếu của một bộ phim (ví dụ: "giá vé phim dune", "lịch chiếu phim cá mập"), bạn phải TỰ ĐỐI CHIẾU tên phim họ gõ với danh sách "Phim đang chiếu liên quan" ở phía dưới để tìm ra [ID: ...] tương ứng.
    - Tuyệt đối KHÔNG ĐƯỢC hỏi khách hàng xin "ID phim". Khách hàng không biết ID phim là gì.
    - Sau khi tự tìm thấy ID từ danh sách, bạn phải LẬP TỨC kích hoạt công cụ 'getShowtimesForMovie' với movieId đó để lấy dữ liệu thực tế.
    - Nếu không tìm thấy phim nào khớp trong danh sách dưới đây, hãy lịch sự báo rạp hiện chưa có lịch chiếu phim này.

    Format câu trả lời: dùng xuống dòng cho dễ đọc, emoji phù hợp, không quá 300 từ.${prefText}${bookingText}

    Phim đang chiếu liên quan (${relevantMovies.length}/${allMovies.length} phim):
    ${movieContext}`;

            // If user likely asks about price/showtimes, proactively fetch showtimes for top match
            const intentShowtime = /giá|suất|lịch|chiếu|giá vé|vé/i.test(userMessage);
            let autoShowtimesText = '';
            if (intentShowtime && relevantMovies.length > 0) {
                const top = relevantMovies[0];
                console.log(`[AI Debug] user asks about showtimes/prices. Top match: ${top.id} - ${top.title}`);
                const liveShowtimes = await fetchShowtimesInternal(top.id);
                if (liveShowtimes && liveShowtimes.length) {
                    autoShowtimesText = '\n\nDữ liệu suất chiếu (tự động cung cấp cho phim khớp nhất):\n' +
                        liveShowtimes.map(s => `• [${s.id}] ${s.start_time} - ${s.hall || 'phòng'} - ${s.price || 'N/A'} đ - trống: ${s.available_seats || 0}`).join('\n');
                    console.log('[AI Debug] autoShowtimes fetched:', liveShowtimes.length, 'items for', top.id);
                } else {
                    console.log('[AI Debug] no live showtimes found for', top.id);
                }
            }

            // Append any auto-showtimes info to system instruction so the model sees live data
            if (autoShowtimesText) {
                systemInstruction += autoShowtimesText;
            }

        // 5. GỌI BẢN TIN AI
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction
        });

        const result = await model.generateContent(userMessage);
        const aiReply = result?.response?.text ? result.response.text() : 'Xin lỗi, tôi gặp chút sự cố, bạn thử lại nhé!';

        // 6. GHI LOG CHẠY NGẦM (Không block tiến trình của người dùng)
        db.query('INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)', 
            [userId || null, userMessage, aiReply, JSON.stringify({ mode })]
        ).catch(e => console.warn('Lỗi ghi log AI ngầm:', e.message));

        // Trả kết quả ngay lập tức
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

// GET /api/ai/recommendations/:userId (Đã tối ưu Promise.all xử lý đa luồng)
exports.recommendations = async (req, res) => {
    const { userId } = req.params;
    try {
        const [prefs, moviesResult, bookedResult] = await Promise.all([
            userId ? safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]) : Promise.resolve(null),
            safeQuery('SELECT id, title, genre, poster_url FROM movies'),
            userId ? safeQuery(`SELECT DISTINCT m.id FROM bookings b JOIN showtimes s ON b.showtime_id = s.id JOIN movies m ON s.movie_id = m.id WHERE b.user_id = ?`, [userId]) : Promise.resolve([])
        ]);

        const prefGenres = prefs && prefs[0] && prefs[0].genres ? prefs[0].genres.split(',').map(s => s.trim().toLowerCase()) : [];
        const movies = moviesResult || [];
        const bookedIds = new Set((bookedResult || []).map(r => r.id));

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
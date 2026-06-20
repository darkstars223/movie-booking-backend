const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
const NodeCache = require("node-cache");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Khởi tạo bộ đệm Cache - Thời gian sống mặc định (stdTTL) là 5 phút (300 giây)
const appCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (err) {
        console.error('DB query error:', err);
        return null;
    }
};


// 1. Lấy lịch chiếu kèm giá vé 
const getCachedShowtimesContext = async () => {
    const cacheKey = "ai_showtimes_context";
    
    // Nếu có dữ liệu trong cache thì trả về luôn, không truy vấn DB
    if (appCache.has(cacheKey)) {
        return appCache.get(cacheKey);
    }

    // Nếu không có, tiến hành truy vấn DB
    const activeMovies = await safeQuery(`
        SELECT DISTINCT m.id, m.title, m.genre 
        FROM movies m
        JOIN showtimes s ON m.id = s.movie_id
        WHERE s.start_time >= NOW()
        LIMIT 10
    `) || [];

    const showtimes = await safeQuery(`
        SELECT movie_id, start_time, price, room_name
        FROM showtimes
        WHERE start_time >= NOW()
        ORDER BY start_time ASC
        LIMIT 30
    `) || [];

    const showtimesMap = {};
    showtimes.forEach(s => {
        if (!showtimesMap[s.movie_id]) showtimesMap[s.movie_id] = [];
        const timeStr = new Date(s.start_time).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
        showtimesMap[s.movie_id].push(`+ ${timeStr} | Giá: ${Number(s.price).toLocaleString('vi-VN')}đ | Phòng: ${s.room_name}`);
    });

    const context = activeMovies.map(m => {
        const list = showtimesMap[m.id] ? showtimesMap[m.id].join('\n    ') : '+ Hết vé';
        return `- Phim: ${m.title}\n  Suất:\n    ${list}`;
    }).join('\n\n');

    // Lưu kết quả vào Cache trong 180 giây (3 phút)
    appCache.set(cacheKey, context, 180);
    return context;
};

// 2. Lấy danh sách phim và mô tả ngắn (Cache 10 phút vì danh mục phim ít thay đổi)
const getCachedMoviesContext = async () => {
    const cacheKey = "ai_movies_list_context";

    if (appCache.has(cacheKey)) {
        return appCache.get(cacheKey);
    }

    const movies = await safeQuery(`
        SELECT id, title, genre, LEFT(description, 100) as short_desc 
        FROM movies 
        ORDER BY id DESC 
        LIMIT 10
    `) || [];
    
    const context = movies.map(m => `- Phim: ${m.title} (${m.genre})\n  Tóm tắt: ${m.short_desc}...`).join('\n');

    // Phim ít thay đổi nên lưu cache lâu hơn: 600 giây (10 phút)
    appCache.set(cacheKey, context, 600);
    return context;
};




// POST /api/ai/chat
exports.chatWithAI = async (req, res) => {
    const { userId, userMessage, mode = 'short' } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    try {
        let movieContext = '';
        const cleanMsg = userMessage.toLowerCase();

     
        
        // Nhóm câu hỏi về lịch chiếu, suất chiếu, giá vé
        if (cleanMsg.includes('lịch chiếu') || cleanMsg.includes('suất chiếu') || cleanMsg.includes('giá vé') || cleanMsg.includes('mấy giờ') || cleanMsg.includes('bao nhiêu tiền')) {
            movieContext = await getCachedShowtimesContext();
        } 
        // Nhóm câu hỏi tìm kiếm phim, tư vấn phim đang có
        else if (cleanMsg.includes('phim gì') || cleanMsg.includes('tư vấn') || cleanMsg.includes('gợi ý') || cleanMsg.includes('tìm phim') || cleanMsg.includes('đang chiếu')) {
            movieContext = await getCachedMoviesContext();
        } 
        // Nhóm câu hỏi chào hỏi thông thường hoặc ngoài lề
        else {
            movieContext = "Hiện tại người dùng đang trao đổi thông tin chung, hãy trả lời thân thiện trên tư cách trợ lý rạp phim TTV.";
        }

        // --- BƯỚC 2: TRUY VẤN THÔNG TIN CÁ NHÂN USER (KHÔNG CACHE VÌ MỖI USER MỘT KHÁC) ---
        let prefText = '';
        if (userId) {
            const prefs = await safeQuery('SELECT genres, language FROM user_preferences WHERE user_id = ?', [userId]);
            if (prefs && prefs.length > 0) {
                prefText = `Sở thích user: Thể loại ưa thích là ${prefs[0].genres || 'Chưa rõ'}.`;
            }
        }

        let bookingText = '';
        if (userId && (cleanMsg.includes('đã đặt') || cleanMsg.includes('lịch sử') || cleanMsg.includes('gợi ý'))) {
            const history = await safeQuery(`
                SELECT m.title FROM bookings b
                JOIN showtimes s ON b.showtime_id = s.id
                JOIN movies m ON s.movie_id = m.id
                WHERE b.user_id = ? ORDER BY b.booking_time DESC LIMIT 3
            `, [userId]);
            if (history && history.length) {
                bookingText = 'Phim khách đã xem gần đây: ' + history.map(h => h.title).join(', ') + '.';
            }
        }

        // --- BƯỚC 3: ĐÓNG GÓI SYSTEM INSTRUCTION VÀ GỌI GEMINI ---
        const systemInstruction = `Bạn là trợ lý ảo chính thức của rạp phim TTV.
NHIỆM VỤ :
- CHỈ ĐƯỢC trả lời, gợi ý các bộ phim có tên cụ thể nằm trong mục "Dữ liệu rạp đang có" bên dưới.
- TUYỆT ĐỐI KHÔNG tự bịa ra tên bộ phim, lịch chiếu hoặc giá vé nào khác nằm ngoài dữ liệu được cung cấp.
- Nếu người dùng hỏi về phim/lịch chiếu không có trong dữ liệu hoặc dữ liệu trống, hãy lịch sự báo rằng rạp hiện chưa có suất chiếu cho phim đó hoặc đang cập nhật, tuyệt đối không tự lấy dữ liệu từ kiến thức bên ngoài của bạn.
- Trả lời ngắn gọn, xuống dòng rõ ràng, phân tách ý bằng dấu gạch đầu dòng.

Thông tin hỗ trợ cá nhân (chỉ sử dụng nếu liên quan):
${prefText}
${bookingText}

Dữ liệu rạp đang có:
${movieContext}`;

        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction
        });

        const result = await model.generateContent(userMessage);
        const aiReply = result?.response?.text ? result.response.text() : 'Xin lỗi, tôi không thể trả lời lúc này.';

        // Lưu log tương tác
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
        await db.query(`
            INSERT INTO user_preferences (user_id, genres, language, seat_pref)
            VALUES (?, ?, ?)
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
        let prefs = null;
        if (userId) prefs = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
        const prefGenres = prefs && prefs[0] && prefs[0].genres ? prefs[0].genres.split(',').map(s => s.trim().toLowerCase()) : [];

        const movies = await safeQuery('SELECT id, title, genre, poster_url FROM movies');
        const booked = userId ? await safeQuery(`SELECT DISTINCT m.id FROM bookings b JOIN showtimes s ON b.showtime_id = s.id JOIN movies m ON s.movie_id = m.id WHERE b.user_id = ?`, [userId]) : [];
        const bookedIds = new Set((booked || []).map(r => r.id));

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
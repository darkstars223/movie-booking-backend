const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =============================================
// CACHE LAYER - tránh query DB mỗi request
// =============================================
const cache = {
    movies: null,
    moviesAt: 0,
    MOVIES_TTL: 5 * 60 * 1000, // 5 phút
};

const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (err) {
        console.error('DB query error:', err);
        return null;
    }
};

// Lấy danh sách phim với cache
const getCachedMovies = async () => {
    if (cache.movies && Date.now() - cache.moviesAt < cache.MOVIES_TTL) {
        return cache.movies;
    }
    const movies = await safeQuery(
        'SELECT id, title, genre, description FROM movies LIMIT 200'
    ) || [];
    cache.movies = movies;
    cache.moviesAt = Date.now();
    console.log(`[AI Cache] Movies refreshed: ${movies.length} items`);
    return movies;
};

// Xóa cache (gọi khi thêm/sửa phim)
const invalidateMovieCache = () => {
    cache.movies = null;
    cache.moviesAt = 0;
};

// =============================================
// SMART FILTER - chỉ lấy phim liên quan
// =============================================
const filterRelevantMovies = (movies, userMessage, limit = 8) => {
    const raw = userMessage.toLowerCase();
    const keywords = raw
        .split(/[\s,]+/)
        .filter(k => k.length > 2)
        .map(k => k.replace(/[^a-zàáâãèéêìíòóôõùúăđĩũơưạặắẵ0-9]/gi, ''));

    if (keywords.length === 0) return movies.slice(0, limit);

    const scored = movies.map(m => {
        const haystack = `${m.title} ${m.genre} ${m.description || ''}`.toLowerCase();
        let score = 0;
        for (const k of keywords) {
            if (haystack.includes(k)) score += (m.title.toLowerCase().includes(k) ? 3 : 1);
        }
        return { ...m, _score: score };
    });

    const relevant = scored
        .filter(m => m._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, limit);

    // Fallback: nếu không match, trả phim ngẫu nhiên
    return relevant.length >= 3 ? relevant : movies.slice(0, limit);
};

// =============================================
// FORMAT ngắn gọn cho prompt
// =============================================
const buildMovieContext = (movies) =>
    movies
        .map(m => {
            const desc = (m.description || '').slice(0, 120).replace(/\n/g, ' ');
            return `• ${m.title} [${m.genre}]: ${desc}`;
        })
        .join('\n');

// =============================================
// POST /api/ai/chat
// =============================================
exports.chatWithAI = async (req, res) => {
    const { userId, userMessage } = req.body;
    if (!userMessage?.trim()) {
        return res.status(400).json({ error: 'userMessage is required' });
    }

    try {
        // 1. Lấy phim từ cache, lọc liên quan
        const allMovies = await getCachedMovies();
        const relevantMovies = filterRelevantMovies(allMovies, userMessage);
        const movieContext = buildMovieContext(relevantMovies);

        // 2. Lấy preferences người dùng (nếu có)
        let prefText = '';
        if (userId) {
            const prefs = await safeQuery(
                'SELECT * FROM user_preferences WHERE user_id = ?', [userId]
            );
            if (prefs?.length > 0) {
                const p = prefs[0];
                prefText = `\nSở thích người dùng: thể loại=${p.genres || 'chưa rõ'}; ngôn ngữ=${p.language || 'vi'}; ghế=${p.seat_pref || 'chưa rõ'}`;
            }
        }

        // 3. Lấy lịch sử đặt vé gần nhất (nếu có)
        let bookingText = '';
        if (userId) {
            const history = await safeQuery(`
                SELECT m.title, m.genre, b.status, b.booking_time
                FROM bookings b
                JOIN showtimes s ON b.showtime_id = s.id
                JOIN movies m ON s.movie_id = m.id
                WHERE b.user_id = ?
                ORDER BY b.booking_time DESC
                LIMIT 5
            `, [userId]);
            if (history?.length) {
                bookingText = '\nĐặt vé gần đây:\n' +
                    history.map(h => `• ${h.title} (${h.genre}) - ${h.status}`).join('\n');
            }
        }

        // 4. Build system prompt gọn
        const systemInstruction = `Bạn là trợ lý AI của rạp phim TTV. Trả lời thân thiện, ngắn gọn, chính xác.
        Chỉ hỗ trợ: tư vấn phim, đặt vé, suất chiếu, giá vé.web chưa có hệ thống giảm giá voucher. Câu hỏi ngoài phạm vi rạp phim thì từ chối lịch sự.
            Format câu trả lời: dùng xuống dòng cho dễ đọc, emoji phù hợp, không quá 300 từ.${prefText}${bookingText}

Phim đang chiếu liên quan (${relevantMovies.length}/${allMovies.length} phim):
${movieContext}`;

        // 5. Gọi Gemini
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction,
        });

        const result = await model.generateContent(userMessage);
        const aiReply = result?.response?.text?.()
            || 'Xin lỗi, tôi không thể trả lời lúc này. Bạn thử lại nhé!';

        // 6. Lưu log (không block response)
        db.query(
            'INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)',
            [userId || null, userMessage, aiReply, JSON.stringify({ movies_used: relevantMovies.length })]
        ).catch(e => console.warn('[AI Log] Không lưu được:', e.message));

        res.json({ reply: aiReply });

    } catch (error) {
        console.error('Lỗi chatWithAI:', error);
        res.status(500).json({ reply: 'Hệ thống AI đang bận, bạn thử lại sau nhé! 🙏' });
    }
};

// =============================================
// GET /api/ai/preferences/:userId
// =============================================
exports.getPreferences = async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const rows = await safeQuery(
        'SELECT * FROM user_preferences WHERE user_id = ?', [userId]
    );
    if (!rows) return res.status(500).json({ error: 'DB error' });
    res.json(rows[0] || {});
};

// =============================================
// PUT /api/ai/preferences/:userId
// =============================================
exports.updatePreferences = async (req, res) => {
    const { userId } = req.params;
    const { genres = '', language = 'vi', seat_pref = '' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        await db.query(`
            INSERT INTO user_preferences (user_id, genres, language, seat_pref)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                genres = VALUES(genres),
                language = VALUES(language),
                seat_pref = VALUES(seat_pref)
        `, [userId, genres, language, seat_pref]);
        res.json({ ok: true });
    } catch (err) {
        console.error('Lỗi updatePreferences:', err);
        res.status(500).json({ error: 'DB error' });
    }
};

// =============================================
// GET /api/ai/recommendations/:userId
// =============================================
exports.recommendations = async (req, res) => {
    const { userId } = req.params;
    try {
        const allMovies = await getCachedMovies();

        let prefGenres = [];
        if (userId) {
            const prefs = await safeQuery(
                'SELECT * FROM user_preferences WHERE user_id = ?', [userId]
            );
            if (prefs?.[0]?.genres) {
                prefGenres = prefs[0].genres.split(',').map(s => s.trim().toLowerCase());
            }
        }

        const booked = userId ? await safeQuery(`
            SELECT DISTINCT m.id FROM bookings b
            JOIN showtimes s ON b.showtime_id = s.id
            JOIN movies m ON s.movie_id = m.id
            WHERE b.user_id = ?
        `, [userId]) : [];
        const bookedIds = new Set((booked || []).map(r => r.id));

        const scored = allMovies.map(m => {
            let score = 0;
            const genres = (m.genre || '').toLowerCase().split(',').map(s => s.trim());
            if (prefGenres.length && genres.some(g => prefGenres.includes(g))) score += 10;
            if (!bookedIds.has(m.id)) score += 5;
            return { id: m.id, title: m.title, poster_url: m.poster_url, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 8).map(s => ({
            id: s.id,
            title: s.title,
            poster_url: s.poster_url,
            reason: 'Phù hợp sở thích của bạn',
        }));

        res.json({ recommendations: top });
    } catch (err) {
        console.error('Lỗi recommendations:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// =============================================
// GET /api/ai/logs
// =============================================
exports.getLogs = async (req, res) => {
    try {
        const rows = await safeQuery(`
            SELECT id, user_id, user_query, ai_response, meta, created_at
            FROM ai_interactions
            ORDER BY created_at DESC
            LIMIT 200
        `);
        res.json({ logs: rows || [] });
    } catch (err) {
        console.error('Lỗi getLogs:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// =============================================
// GET /api/ai/showtimes?movieId=123
// =============================================
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

// Export cache invalidation cho dùng ở movieController nếu cần
exports.invalidateMovieCache = invalidateMovieCache;
const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

// Lazy initialization for GoogleGenerativeAI so we can detect missing API key
let genAI = null;
const getGenAI = () => {
    if (genAI) return genAI;
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        const msg = 'GEMINI_API_KEY is not set in environment';
        console.error('[AI Init] ' + msg);
        throw new Error(msg);
    }
    genAI = new GoogleGenerativeAI(key);
    return genAI;
};

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
    
    // Tách từ khóa: Giữ lại từ có độ dài > 2 HOẶC từ có chứa ký tự số (ví dụ: "4", "13")
    const keywords = raw
        .split(/[\s,]+/)
        .map(k => k.replace(/[^a-zàáâãèéêìíòóôõùúăđĩũơưạặắẵ0-9]/gi, ''))
        .filter(k => k.length > 2 || /\d+/.test(k)); // Giữ lại nếu dài hoặc là số

    if (keywords.length === 0) return movies.slice(0, limit);

    // Hàm xóa khoảng trắng để so sánh viết liền (ví dụ: "kungfupanda4")
    const cleanSpaces = (str) => str.toLowerCase().replace(/\s+/g, '');
    const rawNoSpaces = cleanSpaces(raw);

    const scored = movies.map(m => {
        const titleLower = m.title.toLowerCase();
        const titleNoSpaces = cleanSpaces(m.title);
        const haystack = `${m.title} ${m.genre} ${m.description || ''}`.toLowerCase();
        const haystackNoSpaces = cleanSpaces(haystack);
        
        let score = 0;

        // 1. ƯU TIÊN CAO NHẤT: Nếu toàn bộ tên phim (xóa cách) xuất hiện trong câu hỏi hoặc ngược lại
        if (rawNoSpaces.includes(titleNoSpaces) || titleNoSpaces.includes(rawNoSpaces)) {
            score += 30; 
        }

        // 2. Tính điểm theo từng từ khóa đơn lẻ
        for (const k of keywords) {
            if (haystack.includes(k) || haystackNoSpaces.includes(k)) {
                // Nếu khớp trong tiêu đề thì điểm cao hơn khớp trong mô tả
                score += (titleLower.includes(k) || titleNoSpaces.includes(k) ? 5 : 1);
            }
        }
        
        return { ...m, _score: score };
    });

    // Lọc ra các phim có điểm > 0 và sắp xếp điểm từ cao xuống thấp
    const relevant = scored
        .filter(m => m._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, limit);

    // Nếu tìm thấy bất kỳ phim nào khớp thực sự (dù chỉ 1 phim), hãy ưu tiên trả về danh sách đó 
    // Thay vì điều kiện `>= 3` cũ dễ bị lọt lưới. Nếu hoàn toàn bằng 0 mới trả về mặc định.
    return relevant.length > 0 ? relevant : movies.slice(0, limit);
};

// =============================================
// FORMAT ngắn gọn cho prompt
// =============================================
const buildMovieContext = (movies) =>
    movies
        .map(m => {
            const desc = (m.description || '').slice(0, 120).replace(/\n/g, ' ');
            return `• [ID: ${m.id}] ${m.title} [${m.genre}]: ${desc}`; // Cung cấp ID để AI biết đường gọi Tool
        })
        .join('\n');

// Hàm thực thi logic lấy suất chiếu trực tiếp từ DB cho Function Calling
const fetchShowtimesInternal = async (movieId) => {
    const rows = await safeQuery(`
        SELECT s.id, s.movie_id, s.start_time, s.price, s.available_seats, s.hall
        FROM showtimes s
        WHERE s.movie_id = ?
          AND (s.start_time IS NULL OR s.start_time >= NOW())
        ORDER BY s.start_time
        LIMIT 50
    `, [movieId]);
    return rows || [];
};

// =============================================
// POST /api/ai/chat
// =============================================
exports.chatWithAI = async (req, res) => {
    const { userId, userMessage } = req.body;
    if (!userMessage?.trim()) {
        return res.status(400).json({ error: 'userMessage is required' });
    }

    try {
        // Ensure AI client available
        const genAIclient = getGenAI();

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
        const systemInstruction = `Bạn là trợ lý AI thông minh của rạp phim TTV. Trả lời thân thiện, ngắn gọn, chính xác.
Chỉ hỗ trợ: tư vấn phim, đặt vé, suất chiếu, giá vé. Web chưa có hệ thống giảm giá voucher. Câu hỏi ngoài phạm vi rạp phim thì từ chối lịch sự.

QUY TẮC QUAN TRỌNG VỀ TRA CỨU SUẤT CHIẾU VÀ GIÁ VÉ:
- Khi khách hàng hỏi về giá vé, suất chiếu, lịch chiếu hoặc phòng chiếu của một bộ phim (ví dụ: "giá vé phim dune", "lịch chiếu phim cá mập"), bạn phải TỰ ĐỐI CHIẾU tên phim họ gõ với danh sách "Phim đang chiếu liên quan" ở phía dưới để tìm ra [ID: ...] tương ứng.
- Tuyệt đối KHÔNG ĐƯỢC hỏi khách hàng xin "ID phim". Khách hàng không biết ID phim là gì.
- Sau khi tự tìm thấy ID từ danh sách, bạn phải LẬP TỨC kích hoạt công cụ \`getShowtimesForMovie\` với movieId đó để lấy dữ liệu thực tế.
- Nếu không tìm thấy phim nào khớp trong danh sách dưới đây, hãy lịch sự báo rạp hiện chưa có lịch chiếu phim này.

Format câu trả lời: dùng xuống dòng cho dễ đọc, emoji phù hợp, không quá 300 từ.${prefText}${bookingText}

Phim đang chiếu liên quan (${relevantMovies.length}/${allMovies.length} phim):
${movieContext}`;

        // Định nghĩa Tool (Function Declaration) cho Gemini
        const showtimesTool = {
            functionDeclarations: [
                {
                    name: "getShowtimesForMovie",
                    description: "Lấy danh sách các suất chiếu, lịch chiếu, giá vé, số ghế trống và phòng chiếu của một bộ phim dựa theo ID phim.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            movieId: {
                                type: "NUMBER",
                                description: "ID của bộ phim cần tra cứu suất chiếu và giá vé.",
                            },
                        },
                        required: ["movieId"],
                    },
                },
            ],
        };

        // 5. Khởi tạo Model với Tools
        // create model via client
        const model = genAIclient.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction,
            tools: [showtimesTool], 
        });

        // Bắt đầu phiên chat tự động xử lý Function Calling
        const chat = model.startChat();
        let result;
        try {
            result = await chat.sendMessage(userMessage);
        } catch (errSend) {
            console.error('[AI] sendMessage failed:', errSend?.message || errSend);
            throw errSend;
        }
        
        // Kiểm tra xem AI có yêu cầu gọi hàm tra cứu lịch/giá vé dưới DB không
        const functionCalls = result.response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            
            if (call.name === "getShowtimesForMovie") {
                const { movieId } = call.args;
                console.log(`[AI Tool] Kích hoạt tra cứu suất chiếu cho movieId: ${movieId}`);
                
                // Truy vấn dữ liệu thực tế (bảo gồm giá 20k, 60k...) từ database
                const dbShowtimes = await fetchShowtimesInternal(movieId);
                
                // Trả kết quả DB ngược lại cho AI xử lý tiếp
                result = await chat.sendMessage([
                    {
                        functionResponse: {
                            name: "getShowtimesForMovie",
                            response: { showtimes: dbShowtimes }
                        }
                    }
                ]);
            }
        }

        const aiReply = (typeof result?.response?.text === 'function') ? result.response.text() : (result?.response?.text || '');
        const finalReply = aiReply || 'Xin lỗi, tôi không thể trả lời lúc này. Bạn thử lại nhé!';

        // 6. Lưu log (không block response)
        db.query(
            'INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)',
            [userId || null, userMessage, finalReply, JSON.stringify({ movies_used: relevantMovies.length })]
        ).catch(e => console.warn('[AI Log] Không lưu được:', e.message));

        res.json({ reply: finalReply });

    } catch (error) {
        // Log full error for diagnosis
        console.error('Lỗi chatWithAI:', error && (error.stack || error));
        // If error indicates missing API key, return clear message
        if (String(error.message || '').includes('GEMINI_API_KEY')) {
            return res.status(500).json({ reply: 'Lỗi cấu hình AI: GEMINI_API_KEY chưa được thiết lập.' });
        }
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
// GET /api/ai/showtimes?movieId=123 (Endpoint dành cho frontend gọi lẻ nếu cần)
// =============================================
exports.getShowtimesForAI = async (req, res) => {
    const { movieId } = req.query;
    if (!movieId) return res.status(400).json({ error: 'movieId is required' });

    try {
        const rows = await fetchShowtimesInternal(movieId);
        res.json({ showtimes: rows });
    } catch (err) {
        console.error('Lỗi getShowtimesForAI:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.invalidateMovieCache = invalidateMovieCache;
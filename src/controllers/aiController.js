const { GoogleGenerativeAI, Type } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Hàm truy vấn DB an toàn
const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (err) {
        console.error('DB query error:', err);
        return null;
    }
};

// ==========================================
// ĐỊNH NGHĨA CACHE (BỘ NHỚ ĐỆM) TRÁNH QUÁ TẢI DB
// ==========================================
let movieCache = {
    data: null,
    lastFetched: 0
};
const CACHE_TIMEOUT = 10 * 60 * 1000; // 10 phút cập nhật lại từ DB 1 lần

// ==========================================
// ĐỊNH NGHĨA TOOLS (HÀM BỔ TRỢ CHO AI)
// ==========================================
const getMoviesTool = {
    name: "getAvailableMovies",
    description: "Lấy danh sách toàn bộ các bộ phim đang chiếu tại rạp bao gồm ID, tiêu đề, thể loại và mô tả.",
    parameters: {
        type: Type.OBJECT,
        properties: {},
    },
};

const getShowtimesTool = {
    name: "getShowtimesForMovie",
    description: "Lấy danh sách các suất chiếu sắp tới của một bộ phim cụ thể dựa vào ID phim.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            movieId: {
                type: Type.INTEGER,
                description: "ID số nguyên của bộ phim cần tra cứu suất chiếu (ví dụ: 1, 2, 123)",
            },
        },
        required: ["movieId"],
    },
};

// ==========================================
// LOGIC THỰC THI CÁC HÀM TRA CỨU (HAVE CACHE)
// ==========================================
const aiToolsFunctions = {
    getAvailableMovies: async () => {
        const now = Date.now();
        // Nếu chưa có cache hoặc cache hết hạn -> Query DB
        if (!movieCache.data || (now - movieCache.lastFetched) > CACHE_TIMEOUT) {
            const rows = await safeQuery('SELECT id, title, genre, description FROM movies LIMIT 50') || [];
            movieCache.data = rows;
            movieCache.lastFetched = now;
        }
        return { movies: movieCache.data };
    },
    getShowtimesForMovie: async ({ movieId }) => {
        const rows = await safeQuery(`
            SELECT s.id, s.start_time, s.price, s.available_seats, s.hall
            FROM showtimes s
            WHERE s.movie_id = ? AND (s.start_time IS NULL OR s.start_time >= NOW())
            ORDER BY s.start_time LIMIT 10
        `, [movieId]);
        return { showtimes: rows || [] };
    }
};

// ==========================================
// API CHÍNH: POST /api/ai/chat
// ==========================================
exports.chatWithAI = async (req, res) => {
    const { userId, userMessage, mode = 'short' } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    try {
        // 1. Thu thập ngữ cảnh cá nhân hóa (Ngắn gọn, không bốc dữ liệu phim ở đây)
        let prefText = '';
        if (userId) {
            const prefs = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
            if (prefs && prefs.length > 0) {
                const p = prefs[0];
                prefText = `Sở thích user: Thể loại ưa thích=${p.genres || 'Chưa rõ'}, Ngôn ngữ=${p.language || 'vi'}, Chỗ ngồi thương chọn=${p.seat_pref || 'Không có'}.\n`;
            }
        }

        let bookingText = '';
        if (userId) {
            const history = await safeQuery(`
                SELECT m.title, b.status 
                FROM bookings b
                JOIN showtimes s ON b.showtime_id = s.id
                JOIN movies m ON s.movie_id = m.id
                WHERE b.user_id = ? ORDER BY b.booking_time DESC LIMIT 3
            `, [userId]);
            if (history && history.length) {
                bookingText = 'Lịch sử đặt vé gần đây:\n' + history.map(h => `- Phim ${h.title} (Trạng thái: ${h.status})`).join('\n') + '\n';
            }
        }

        // 2. Thiết lập System Instruction (Không nhét cục 50 phim vào đây nữa)
        const systemInstruction = `Bạn là trợ lý ảo thông minh của rạp phim TTV.
Nhiệm vụ: Tư vấn phim, cung cấp lịch chiếu, giá vé, hỗ trợ đặt vé.
Yêu cầu phản hồi: Thân thiện, ngắn gọn, tự động xuống dòng (sử dụng dấu xuống dòng \\n) để bố cục rõ ràng, dễ đọc trên màn hình chat nhỏ.
Phạm vi: Chỉ trả lời các câu hỏi liên quan đến rạp phim TTV, phim ảnh, lịch chiếu tại rạp. Từ chối lịch sự nếu câu hỏi nằm ngoài phạm vi.

Ngữ cảnh khách hàng hiện tại:
${prefText}${bookingText}
Hãy sử dụng các công cụ (Tools) được cung cấp để tra cứu danh sách phim hoặc suất chiếu khi khách hàng yêu cầu dữ liệu thực tế.`;

        // 3. Khởi tạo Model tích hợp Tools định sẵn
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite', // Model tốc độ cao, tiết kiệm chi phí
            systemInstruction,
            tools: [{ functionDeclarations: [getMoviesTool, getShowtimesTool] }],
        });

        // 4. Lượt gọi AI đầu tiên để kiểm tra xem user có cần dùng công cụ không
        const result = await model.generateContent(userMessage);
        const functionCalls = result.response.functionCalls;

        let aiReply = '';

        // Kiểm tra xem Gemini có yêu cầu gọi Hàm (Tool) hay không
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            const functionName = call.name;
            const functionArgs = call.args;

            // Chạy hàm lấy dữ liệu từ DB (hoặc từ Cache) tương ứng với yêu cầu của AI
            const functionResult = await aiToolsFunctions[functionName](functionArgs);

            // Gửi dữ liệu thô ngược lại cho Gemini để nó biên dịch thành câu trả lời tự nhiên
            const secondCallResult = await model.generateContent([
                userMessage,
                result.response,
                {
                    functionResponse: {
                        name: functionName,
                        response: functionResult
                    }
                }
            ]);
            aiReply = secondCallResult.response.text();
        } else {
            // Nếu người dùng chỉ chào hỏi hoặc hỏi linh tinh, AI tự trả lời luôn, không truy vấn DB phim
            aiReply = result.response.text();
        }

        // 5. Ghi Log tương tác vào DB (Bọc try-catch độc lập để không làm sập luồng chat chính)
        try {
            await db.query('INSERT INTO ai_interactions (user_id, user_query, ai_response, meta) VALUES (?, ?, ?, ?)', [userId || null, userMessage, aiReply, JSON.stringify({ mode })]);
        } catch (e) {
            console.warn('Không thể lưu tương tác AI:', e.message);
        }

        res.json({ reply: aiReply });
    } catch (error) {
        console.error('Lỗi tại chatWithAI:', error);
        res.status(500).json({ reply: 'Hệ thống AI đang bảo trì, bạn thử lại sau nhé!' });
    }
};

// ==========================================
// CÁC ROUTE CÒN LẠI GIỮ NGUYÊN BẢN CỦA BẠN
// ==========================================
exports.getPreferences = async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const rows = await safeQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
    if (!rows) return res.status(500).json({ error: 'DB error' });
    res.json(rows[0] || {});
};

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

exports.getLogs = async (req, res) => {
    try {
        const rows = await safeQuery('SELECT id, user_id, user_query, ai_response, meta, created_at FROM ai_interactions ORDER BY created_at DESC LIMIT 200');
        res.json({ logs: rows || [] });
    } catch (err) {
        console.error('Lỗi getLogs:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.getShowtimesForAI = async (req, res) => {
    const { movieId } = req.query;
    if (!movieId) return res.status(400).json({ error: 'movieId is required' });
    try {
        const rows = await safeQuery(`
            SELECT s.id, s.movie_id, s.start_time, s.price, s.available_seats, s.hall
            FROM showtimes s WHERE s.movie_id = ? AND (s.start_time IS NULL OR s.start_time >= NOW())
            ORDER BY s.start_time LIMIT 100
        `, [movieId]);
        if (rows === null) return res.status(500).json({ error: 'DB error' });
        res.json({ showtimes: rows });
    } catch (err) {
        console.error('Lỗi getShowtimesForAI:', err);
        res.status(500).json({ error: 'Server error' });
    }
};
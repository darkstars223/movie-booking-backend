const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require('../configs/db');
require('dotenv').config();

// Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.chatWithAI = async (req, res) => {
    const { userMessage } = req.body;

    try {
        // 1. Lấy ngữ cảnh từ Database (PI 2.1)
        const [movies] = await db.query('SELECT title, genre, description FROM movies');
        const movieContext = movies.map(m => `- ${m.title} (${m.genre}): ${m.description}`).join('\n');

        // 2. Thiết lập Model (Sử dụng gemini-2.5-flash-lite để có tốc độ nhanh nhất)
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            systemInstruction: `Bạn là trợ lý ảo của 1 rạp phim , mọi câu hỏi ngoài lề lĩnh vực này bạn không trả lời . 
            Dưới đây là danh sách phim đang chiếu:
            ${movieContext}
            Hãy tư vấn cho khách hàng dựa trên danh sách này. Trả lời cực kỳ ngắn gọn , thân thiện.`
        });

        // 3. Gửi tin nhắn và nhận phản hồi
        const result = await model.generateContent(userMessage);
        const aiReply = result.response.text();

        // 4. Lưu lại lịch sử tương tác (PI 2.1)
        await db.query('INSERT INTO ai_interactions (user_query, ai_response) VALUES (?, ?)', [userMessage, aiReply]);

        res.json({ reply: aiReply });
    } catch (error) {
        console.error("Lỗi Gemini API:", error);
        res.status(500).json({ reply: "Hệ thống AI đang bảo trì, bạn thử lại sau nhé!" });
    }
};
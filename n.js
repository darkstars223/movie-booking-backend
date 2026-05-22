const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listAllModels() {
  try {
    // Sử dụng phương thức listModels để xem danh sách
    const models = await genAI.listModels();
    console.log("--- DANH SÁCH MODEL BẠN CÓ THỂ DÙNG ---");
    models.forEach((m) => {
      console.log(`Tên: ${m.name} | Các phương thức: ${m.supportedGenerationMethods}`);
    });
  } catch (error) {
    console.error("Không thể lấy danh sách model:", error.message);
  }
}

listAllModels();
const db = require('../configs/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
    const { fullname, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (fullname, email, password) VALUES (?, ?, ?)',
            [fullname, email, hashedPassword]
        );
        res.status(201).json({ message: "Đăng ký thành công!" });
    } catch (err) {
        res.status(500).json({ message: "Email đã tồn tại hoặc lỗi server" });
    }
};

exports.login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(404).json({ message: "Tài khoản không tồn tại" });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Mật khẩu không chính xác" });

        // Trả về thông tin user bao gồm cả role để Frontend lưu vào localStorage
        res.json({ 
            user: { 
                id: user.id, 
                fullname: user.fullname, 
                role: user.role 
            } 
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.changePassword = async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    try {
        if (!userId || !oldPassword || !newPassword) {
            return res.status(400).json({ message: "Vui lòng cung cấp đầy đủ thông tin" });
        }

        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ message: "Người dùng không tồn tại" });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Mật khẩu cũ không chính xác" });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, userId]);

        res.json({ message: "Thay đổi mật khẩu thành công!" });
    } catch (err) {
        res.status(500).json({ message: "Lỗi server: " + err.message });
    }
};
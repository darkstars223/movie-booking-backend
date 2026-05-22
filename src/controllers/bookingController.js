const db = require('../configs/db');

const ticketSelect = `
    SELECT
        b.id,
        b.user_id,
        b.showtime_id,
        b.seat_id,
        b.total_price,
        b.status,
        b.booking_time,
        m.title,
        m.poster_url,
        s.start_time,
        TIMESTAMPADD(MINUTE, COALESCE(CAST(m.duration AS SIGNED), 0), s.start_time) as end_time,
        st.seat_number,
        s.room_name,
        t.name as theater_name
    FROM bookings b
    JOIN showtimes s ON b.showtime_id = s.id
    JOIN movies m ON s.movie_id = m.id
    JOIN seats st ON b.seat_id = st.id
    JOIN theaters t ON s.theater_id = t.id
`;

exports.createBooking = async (req, res) => {
    const { user_id, showtime_id, seat_ids, total_price } = req.body;

    if (!user_id || !showtime_id || !Array.isArray(seat_ids) || seat_ids.length === 0) {
        return res.status(400).json({ message: "Chưa chọn ghế hoặc thiếu thông tin đặt vé!" });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const placeholders = seat_ids.map(() => '?').join(',');
        const [selectedSeats] = await connection.query(
            `SELECT id, is_booked FROM seats WHERE showtime_id = ? AND id IN (${placeholders}) FOR UPDATE`,
            [showtime_id, ...seat_ids]
        );

        if (selectedSeats.length !== seat_ids.length || selectedSeats.some(seat => seat.is_booked)) {
            await connection.rollback();
            return res.status(409).json({ message: "Một số ghế vừa được người khác giữ. Vui lòng chọn lại." });
        }

        const pricePerSeat = Number(total_price || 0) / seat_ids.length;
        for (const seat_id of seat_ids) {
            await connection.query(
                `INSERT INTO bookings (user_id, showtime_id, seat_id, total_price, status)
                 VALUES (?, ?, ?, ?, 'pending')`,
                [user_id, showtime_id, seat_id, pricePerSeat]
            );
        }

        await connection.query(
            `UPDATE seats SET is_booked = TRUE WHERE id IN (${placeholders})`,
            seat_ids
        );

        await connection.commit();
        res.status(201).json({ message: "Đặt vé thành công! Vé đang chờ xác nhận thanh toán." });
    } catch (error) {
        await connection.rollback();
        console.error("Lỗi đặt vé:", error);
        res.status(500).json({ message: "Giao dịch thất bại, vui lòng thử lại." });
    } finally {
        connection.release();
    }
};

exports.getUserTickets = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { user_id } = req.params;
        const [tickets] = await connection.query(
            `${ticketSelect}
             WHERE b.user_id = ?
             ORDER BY b.id DESC`,
            [user_id]
        );

        res.status(200).json(tickets);
    } catch (error) {
        console.error("Lỗi lấy vé:", error);
        res.status(500).json({ message: "Không thể lấy danh sách vé" });
    } finally {
        connection.release();
    }
};

exports.cancelTicket = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { ticket_id } = req.params;

        await connection.beginTransaction();

        const [ticket] = await connection.query(
            'SELECT seat_id, status FROM bookings WHERE id = ? FOR UPDATE',
            [ticket_id]
        );

        if (!ticket.length) {
            await connection.rollback();
            return res.status(404).json({ message: "Không tìm thấy vé" });
        }

        await connection.query(
            'UPDATE bookings SET status = ? WHERE id = ?',
            ['cancel', ticket_id]
        );

        await connection.query(
            'UPDATE seats SET is_booked = FALSE WHERE id = ?',
            [ticket[0].seat_id]
        );

        await connection.commit();
        res.status(200).json({ message: "Hủy vé thành công!" });
    } catch (error) {
        await connection.rollback();
        console.error("Lỗi hủy vé:", error);
        res.status(500).json({ message: "Không thể hủy vé" });
    } finally {
        connection.release();
    }
};

exports.getTicketDetail = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { ticket_id } = req.params;
        const [ticket] = await connection.query(
            `${ticketSelect}
             WHERE b.id = ?`,
            [ticket_id]
        );

        if (ticket.length === 0) {
            return res.status(404).json({ message: "Không tìm thấy vé" });
        }

        res.status(200).json(ticket[0]);
    } catch (error) {
        console.error("Lỗi lấy chi tiết vé:", error);
        res.status(500).json({ message: "Không thể lấy chi tiết vé" });
    } finally {
        connection.release();
    }
};

exports.handleSePayWebhook = async (req, res) => {
    const connection = await db.getConnection();
    try {
        // 1. Xác thực API Key từ SePay (Lấy từ cấu hình bảo mật bạn đã tạo)
        const authHeader = req.headers['authorization'];
       if (authHeader !== 'Apikey vinh_do_an_2026') {
            return res.status(401).json({ message: "Xác thực Webhook thất bại" });
        }
 
        // SePay gửi dữ liệu trong req.body
        const { content, transferAmount } = req.body; 
        
        if (!content) {
            return res.status(200).json({ message: "Không có nội dung giao dịch" });
        }

        // 2. Tìm mã vé từ nội dung chuyển khoản (Regex tìm cụm TK + số)
        // Ví dụ: "Chuyen khoan ve phim TK15" -> ticketId = 15
        const match = content.match(/TK(\d+)/i);
        if (!match) {
            return res.status(200).json({ message: "Nội dung không chứa mã vé hợp lệ" });
        }
        
        const ticketId = match[1];

        await connection.beginTransaction();

        // 3. Kiểm tra vé có tồn tại và đang chờ thanh toán không
        const [ticket] = await connection.query(
            'SELECT id, status FROM bookings WHERE id = ? FOR UPDATE',
            [ticketId]
        );

        if (ticket.length === 0) {
            await connection.rollback();
            return res.status(200).json({ message: "Mã vé không tồn tại trên hệ thống" });
        }

        if (ticket[0].status !== 'pending') {
            await connection.rollback();
            return res.status(200).json({ message: "Vé này đã được xử lý từ trước" });
        }

        // 4. Cập nhật trạng thái sang 'confirmed'
        await connection.query(
            'UPDATE bookings SET status = ? WHERE id = ?',
            ['confirmed', ticketId]
        );

        await connection.commit();
        console.log(`[SePay] Đã xác nhận thanh toán thành công cho vé #${ticketId}`);
        
        // Trả về 200 để SePay biết đã nhận dữ liệu thành công
       res.status(200).json({ success: true });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Lỗi Webhook SePay:", error);
        res.status(500).json({ message: "Lỗi xử lý server" });
    } finally {
        if (connection) connection.release();
    }
};
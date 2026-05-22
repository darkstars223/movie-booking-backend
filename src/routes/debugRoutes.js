const express = require('express');
const router = express.Router();
const debugController = require('../controllers/debugController');
const db = require('../configs/db');

// Routes để debug
router.get('/bookings/all', debugController.getAllBookings);
router.get('/users/all', debugController.getAllUsers);
router.get('/user/:user_id/tickets', debugController.getUserTicketsDebug);
router.get('/showtimes/all', debugController.getAllShowtimes);

// Route để kiểm tra schema của bảng bookings
router.get('/schema/bookings', async (req, res) => {
    try {
        const [columns] = await db.query(`
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'bookings'
        `);
        res.json(columns);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Route để làm sạch status không hợp lệ
router.post('/cleanup-status', async (req, res) => {
    try {
        const [result] = await db.query(`
            UPDATE bookings 
            SET status = 'cancel' 
            WHERE status IN ('cancelled', 'expired')
        `);
        res.json({ 
            message: `Đã sửa ${result.affectedRows} vé có status cũ.`,
            affectedRows: result.affectedRows
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;

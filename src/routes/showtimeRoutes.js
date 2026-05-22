const express = require('express');
const router = express.Router();
const showtimeController = require('../controllers/showtimeController');

// Route để tạo suất chiếu và tự động tạo ghế
router.post('/add', showtimeController.createShowtime);

module.exports = router;
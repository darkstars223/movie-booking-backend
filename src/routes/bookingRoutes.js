const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');

router.post('/create', bookingController.createBooking);
router.get('/user/:user_id', bookingController.getUserTickets);
router.get('/detail/:ticket_id', bookingController.getTicketDetail);
router.put('/cancel/:ticket_id', bookingController.cancelTicket);
router.post('/webhook-sepay', bookingController.handleSePayWebhook);

module.exports = router;
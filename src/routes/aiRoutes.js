const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

// Chat endpoint
router.post('/chat', aiController.chatWithAI);

// Preferences
router.get('/preferences/:userId', aiController.getPreferences);
router.put('/preferences/:userId', aiController.updatePreferences);

// Recommendations
router.get('/recommendations/:userId', aiController.recommendations);

// Showtimes for AI/frontend to display times and prices
router.get('/showtimes', aiController.getShowtimesForAI);

// Admin logs (could be protected later)
router.get('/logs', aiController.getLogs);

module.exports = router;
const express = require('express');
const router = express.Router();
const movieController = require('../controllers/movieController');

router.get('/', movieController.getAllMovies);
router.get('/upcoming/soon', movieController.getUpcomingMovies);
router.get('/:id', movieController.getMovieById);
router.get('/:id/showtimes', movieController.getShowtimesByMovie);
router.get('/seats/:showtimeId', movieController.getSeatsByShowtime);
router.get('/showtime/:showtimeId', movieController.getShowtimeDetail);

module.exports = router;
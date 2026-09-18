const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const authRoutes = require('./routes/auth');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('Connected to MongoDB Atlas'))
.catch((err) => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', require('./routes/api'));

// Basic route for testing
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Spin & Win backend is running' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

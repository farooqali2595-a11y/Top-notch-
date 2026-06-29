const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  number: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  otpCode: {
    type: String,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['owner', 'agent', 'client'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'used', 'expired'],
    default: 'pending'
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('OTP', OTPSchema);
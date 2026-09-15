// lib/guestToken.js
// Lets a guest recruiter reply to one specific conversation via a signed
// link in an email, with no login/password. Narrowly scoped on purpose:
// a leaked token only grants access to the one conversation it was issued for.
import jwt from 'jsonwebtoken';

const SECRET = process.env.GUEST_MESSAGE_TOKEN_SECRET; // separate secret, not your app auth secret

export function signGuestConversationToken({ guestId, conversationId }) {
  return jwt.sign({ guestId, conversationId }, SECRET, { expiresIn: '45d' });
}

export function verifyGuestConversationToken(token) {
  return jwt.verify(token, SECRET); // throws if invalid/expired
}
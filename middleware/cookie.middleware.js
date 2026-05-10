import { v4 as uuidv4 } from "uuid";

export const cookieMiddleware = (req, res, next) => {
  let userId = req.cookies.user_id;

  if (!userId) {
    userId = uuidv4();

    res.cookie("user_id", userId, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  req.userId = userId;

  console.log("🍪 USER COOKIE:", userId); // 🔥 DEBUG

  next();
};
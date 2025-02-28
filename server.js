const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");
require("dotenv").config();
const { db } = require("./fireabse");

const allowedOrigins = [
  "http://localhost:3000",
  "https://ecommerce-git-feature-dashboard-medicos-labopattis-projects.vercel.app",
];

const oauth2client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const app = express();
app.use(express.json());
app.use(
  cors({
    origin:
      "https://ecommerce-git-feature-dashboard-medicos-labopattis-projects.vercel.app",
    credentials: true,
  })
);
// app.use(cors({
//     origin: function (origin, callback) {
//         // Permitir solicitudes sin origen (por ejemplo, desde Postman)
//         if (!origin || allowedOrigins.indexOf(origin) !== -1) {
//             callback(null, true);
//         } else {
//             callback(new Error('No permitido por CORS'));
//         }
//     },
//     credentials: true,
// }));

//Ruta para iniciar el flujo de OAuth
app.get("/auth/google", (req, res) => {
  const url = oauth2client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
    state: req.query.userId, // Pasa el ID del usuario
  });
  console.log("URL de autorización generada:", url);
  res.redirect(url);
});

// Ruta de callback para recibir el codigo de autorizacion
app.post("/oauth2callback", async (req, res) => {
  console.log(req.body);
  const { code, userId } = req.body;
  console.log("ID del usuario recibido:", userId);
  try {
    const { tokens } = await oauth2client.getToken(code);
    // Verifica que el refresh token existe
    if (!tokens.refresh_token) {
      console.warn("No se recibió refresh_token");
    }
    oauth2client.setCredentials(tokens);

    //guardar token en firestore
    await db.collection("tokens-gc").doc(userId).set(tokens);

    res.json({ success: true, tokens });
  } catch (error) {
    console.error("Error en oauth2callback", error);
    res.status(500).send("Error al autenticar con google");
  }
});

app.get("/events", async (req, res) => {
  const { userId } = req.query;
  console.log("userId recibido", userId);
  if (!userId) {
    return res.status(400).json({
      error: "userId no proporcionado",
      details: "Se requiere un userId válido para continuar",
      code: "MISSING_USER_ID",
    });
  }

  try {
    // Obtén los tokens del usuario desde Firestore
    const tokenRef = db.collection("tokens-gc").doc(userId);
    const tokenSnap = await tokenRef.get();

    if (!tokenSnap.exists) {
      return res.status(401).json({
        error: "Usuario no autenticado",
        details:
          "No se encontraron tokens de autenticación para el userId proporcionado",
        code: "USER_NOT_AUTHENTICATED",
      });
    }

    const tokens = tokenSnap.data();
    oauth2client.setCredentials(tokens);

    // Verifica si el token de acceso ha expirado
    const now = new Date();
    if (tokens.expiry_date && now.getTime() > tokens.expiry_date) {
      console.log("El token ha expirado, refrescando...");

      if (!tokens.refresh_token) {
        console.log(
          "No se encontró un refresh_token, redirigiendo a Google..."
        );
        const url = oauth2client.generateAuthUrl({
          access_type: "offline",
          scope: ["https://www.googleapis.com/auth/calendar.readonly"],
          state: userId,
          prompt: "consent", // Fuerza la solicitud de permisos para obtener un nuevo refresh_token
        });
        // return res.json({
        //     needsReauth: true,
        //     authUrl: url
        // });
        return res.status(401).json({
          error: "Reautenticación requerida",
          details:
            "El token ha expirado y no se encontró un refresh_token. Redirigiendo a Google para reautenticación.",
          code: "REAUTH_REQUIRED",
          authUrl: url,
        });
      }

      try {
        const { credentials } = await oauth2client.refreshAccessToken();

        // Si no se obtiene las credenciales, mostramos un error
        if (!credentials || !credentials.access_token) {
          console.error("No se obtuvo el nuevo access_token");
          return res.status(500).send({
            error: "Error al refrescar el token",
            details:
              "No se pudo obtener un nuevo access_token después de refrescar",
            code: "TOKEN_REFRESH_FAILED",
          });
        }

        oauth2client.setCredentials(credentials);
        const tokenData = {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          scope: credentials.scope,
          token_type: credentials.token_type,
          expiry_date: credentials.expiry_date,
        };

        await tokenRef.update(tokenData);
        console.log("Tokens actualizados en Firestore");
      } catch (refreshError) {
        console.error("Error al refrescar el token", refreshError);
        return res.status(500).json({
          error: "Error al refrescar el token",
          details: refreshError.message,
          code: "TOKEN_REFRESH_ERROR",
        });
      }
    }
    // Obtén los eventos del día
    const calendar = google.calendar({ version: "v3", auth: oauth2client });
    const nowISO = new Date().toISOString();
    const tomorrowISO = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString();

    const events = await calendar.events.list({
      calendarId: "primary",
      timeMin: nowISO,
      timeMax: tomorrowISO,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json({ success: true, events: events.data.items });
  } catch (error) {
    console.error("Error al obtener los eventos", error);
    res.status(500).send({
      error: "Error al obtener los eventos",
      details: error.message,
      code: "CALENDAR_EVENTS_ERROR",
    });
  }
});

app.post("/refresh-token", async (req, res) => {
  const { refresh_token } = req.body;

  try {
    const { tokens } = await oauth2Client.refreshToken(refresh_token);
    res.json(tokens);
  } catch (error) {
    console.error("Error al refrescar el token:", error);
    res.status(500).send("Error al refrescar el token");
  }
});

app.get("/", (req, res) => {
  res.send("¡Todo está bien! La API está funcionando correctamente.");
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});

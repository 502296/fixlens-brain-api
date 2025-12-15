// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import diagnose from "./api/diagnose.js";
import imageDiagnose from "./api/image-diagnose.js";
import audioDiagnose from "./api/audio-diagnose.js";

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.post("/api/diagnose", diagnose);
app.post("/api/image-diagnose", imageDiagnose);
app.post("/api/audio-diagnose", audioDiagnose);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("FixLens Brain running on port", PORT);
});

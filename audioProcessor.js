// audioProcessor.js

import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function processAudio({
  audio,
  locale
}){

  if(!audio)
    return {text:""};

  const path="/tmp/audio.m4a";

  fs.writeFileSync(
    path,
    Buffer.from(audio,"base64")
  );

  const result =
    await client.audio.transcriptions.create({

      file: fs.createReadStream(path),

      model:"gpt-4o-mini-transcribe"

    });

  return {

    text:
      result.text || ""

  };
}

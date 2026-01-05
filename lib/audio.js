import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath);

export function convertToWav16kMono(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const command = ffmpeg()
      .input(Buffer.from(inputBuffer))
      .inputFormat("mp4") // doesn't force; ffmpeg can autodetect too, but helps iOS sometimes
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("error", (err) => reject(err))
      .on("end", () => resolve(Buffer.concat(chunks)));

    const stream = command.pipe();

    stream.on("data", (c) => chunks.push(c));
    stream.on("error", (e) => reject(e));
  });
}

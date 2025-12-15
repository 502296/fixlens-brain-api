// api/_multipart.js
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: { bodyParser: false },
};

export function parseMultipart(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);

      // formidable يرجّع file كـ object
      const pick = (key) => files?.[key];

      resolve({
        fields,
        files: {
          image: pick("image"),
          audio: pick("audio"),
        },
        readFileBuffer: (file) => fs.readFileSync(file.filepath),
      });
    });
  });
}

import fs from 'fs';

import path from 'path';



export function loadKnowledge() {

  const knowledgeDir = path.join(process.cwd(), 'brain', 'knowledge');

  const files = fs.readdirSync(knowledgeDir);



  let knowledgeBase = {};



  for (const file of files) {

    if (file.endsWith('.json')) {

      const content = fs.readFileSync(

        path.join(knowledgeDir, file),

        'utf8'

      );

      const data = JSON.parse(content);

      const category = file.replace('.json', '');

      knowledgeBase[category] = data;

    }

  }



  return knowledgeBase;

}

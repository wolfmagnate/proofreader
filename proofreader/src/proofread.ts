import OpenAI from 'openai';

type Position = {
  lineIndex: number;
  columnIndex: number;
};

type Range = {
  startsAt: Position;
  endsAt: Position;
};

type DocumentSentence = {
  range: Range;
  text: string;
};

type DocumentSentences = DocumentSentence[];

type MatchResult = 
  | { success: true; startPosition: Position; endPosition: Position }
  | { success: false };

export type CorrectionResult = {
  range: Range;
  errors: string[];
  originalSentence: string;
  correctedSentence: string;
};

class TextProcessor {
    private openai: OpenAI;
  
    private maxConcurrency: number;

    constructor(apiKey: string, maxConcurrency: number = 10) {
      this.openai = new OpenAI({ apiKey });
      this.maxConcurrency = maxConcurrency;
    }

    async processParagraphs(text: string): Promise<DocumentSentences> {
        const paragraphs = this.splitIntoParagraphs(text);
        const tasks = paragraphs.map((paragraph, index) => ({
            paragraph,
            index
        }));

        const results: Array<{ sentences: DocumentSentences, index: number }> = [];
        for (let i = 0; i < tasks.length; i += this.maxConcurrency) {
            const batch = tasks.slice(i, i + this.maxConcurrency);
            const batchResults = await Promise.all(batch.map(async task => {
                const sentences = await this.splitIntoSentences(task.paragraph.text);
                const paragraphSentences = this.calculateRanges(sentences, text, task.paragraph.startLine + 1);
                return { sentences: paragraphSentences, index: task.index };
            }));
            results.push(...batchResults);
        }

        // 元の順序でソート
        results.sort((a, b) => a.index - b.index);

        // ソートされた結果からsentencesだけを抽出
        const sentences = results.flatMap(result => result.sentences);
        
        return sentences;
    }

    async *correctTextStream(sentences: DocumentSentences): AsyncIterableIterator<CorrectionResult> {
      const tasks = sentences.map((sentence, index) => ({ sentence, index }));
      
      for (let i = 0; i < tasks.length; i += this.maxConcurrency) {
        const batch = tasks.slice(i, i + this.maxConcurrency);
        const batchPromises = batch.map(async task => {
          const context = this.getContext(sentences, task.index);
          const prompt = this.createCorrectionPrompt(task.sentence.text, context);
          const response = await this.callOpenAIAPI(prompt);
  
          if (response.error.length > 0 && response.correctedSentence !== task.sentence.text) {
            return {
              range: task.sentence.range,
              errors: response.error,
              originalSentence: task.sentence.text,
              correctedSentence: response.correctedSentence
            };
          } else {
            return {
              range: task.sentence.range,
              errors: [],
              originalSentence: task.sentence.text,
              correctedSentence: task.sentence.text
            };
          }
        });
  
        const batchResults = await Promise.all(batchPromises);
        for (const result of batchResults) {
          yield result
        }
      }
    }

  private splitIntoParagraphs(text: string): { text: string; startLine: number }[] {
    const lines = text.split('\n');
    const paragraphs: { text: string; startLine: number }[] = [];
    let currentParagraph = '';
    let startLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') && currentParagraph) {
        paragraphs.push({ text: currentParagraph.trim(), startLine });
        currentParagraph = '';
        startLine = i;
      }
      currentParagraph += line + '\n';
    }

    if (currentParagraph) {
      paragraphs.push({ text: currentParagraph.trim(), startLine });
    }

    return paragraphs;
  }

  private async splitIntoSentences(text: string): Promise<string[]> {
    const prompt = `
# 命令
あなたはテキスト処理を行うAIです。入力テキストを、文に分割してください。出力形式は、文のリストです。
入力テキストは、MarkDownで記述された1つの段落です。

# 入力テキスト

${text}

# 出力形式
以下のスキーマを持つJSONで出力してください。

{
  "sentences": ["文1", "文2", ..., "文n"]
}

# 注意点
- 文は入力テキストから正確に抜き出してください
- 入力テキストに文章の不備があっても、そのまま抜き出してください。例えば、以下のような場合があります。
    - 文末の句読点が抜けている
- MarkDownで使われている記号もそのまま抜き出してください。例えば、以下のような記号が該当します
    - 強調のためのアスタリスク
    - リストのためのハイフン
    - コードブロックのためのバッククォート
`;

    
    const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: "あなたは優秀なテキスト処理のアシスタントです。JSONで結果を出力します。"
            },
            {
                role: "user",
                content: prompt
            }
        ],
        response_format: {
            type: "json_object"
        }
      });
  
      const result = JSON.parse(response.choices[0].message?.content || '{}');
      return result.sentences || [];
  }

  
  private calculateRanges(sentences: string[], originalText: string, startLine: number): DocumentSentences {
    const result: DocumentSentences = [];
    let currentPosition: Position = { lineIndex: startLine, columnIndex: 0 };
  
    for (const sentence of sentences) {
      const matchResult = this.findEndPosition(sentence, originalText, currentPosition);
      
      if (matchResult.success) {
        result.push({
          range: {
            startsAt: matchResult.startPosition,
            endsAt: matchResult.endPosition,
          },
          text: sentence,
        });
        
        currentPosition = {
          lineIndex: matchResult.endPosition.lineIndex,
          columnIndex: matchResult.endPosition.columnIndex,
        };
      } else {
        console.warn(`Failed to match sentence: "${sentence}"`);
      }
    }
  
    return result;
  }

  private findEndPosition(sentence: string, originalText: string, startPosition: Position): MatchResult {
    const lines = originalText.split('\n');
    let currentLine = startPosition.lineIndex;
    let currentColumn = startPosition.columnIndex;
  
    // 空白を除去
    const cleanSentence = sentence.replace(/\s+/g, '');
  
    let matchCount = 0;
    let matchStartPosition: Position | null = null;
    let matchEndPosition: Position | null = null;
  
    // originalTextをstartPositionの指定する場所から1文字ずつ調べる
    while (currentLine < lines.length) {
      while (currentColumn < lines[currentLine].length) {
        const currentChar = lines[currentLine][currentColumn];
  
        // 文字が空白・改行だったら飛ばす
        if (/\s/.test(currentChar)) {
          currentColumn++;
          continue;
        }
  
        // 文字がcleanSentenceの文字と一致したら、matchCountをインクリメントする
        if (currentChar === cleanSentence[matchCount]) {
          // matchCountが0から1になった場合、マッチ開始位置候補として記録する
          if (matchCount === 0) {
            matchStartPosition = { lineIndex: currentLine, columnIndex: currentColumn };
          }
          matchCount++;
  
          // matchCountがcleanSentenceの長さと一致したら、マッチ終了位置として記録する
          if (matchCount === cleanSentence.length) {
            matchEndPosition = { lineIndex: currentLine, columnIndex: currentColumn + 1 };
            return {
              success: true,
              startPosition: matchStartPosition!,
              endPosition: matchEndPosition
            };
          }
        } else {
          // マッチしなかった場合、matchCountとmatchStartPositionをリセット
          matchCount = 0;
          matchStartPosition = null;
        }
  
        currentColumn++;
      }
  
      // 次の行に移動
      currentLine++;
      currentColumn = 0;
    }
  
    // マッチが見つからなかった場合
    return { success: false };
  }

  private getContext(sentences: DocumentSentences, currentIndex: number): string {
    const contextSentences = sentences.slice(Math.max(0, currentIndex - 2), Math.min(sentences.length, currentIndex + 3));
    return contextSentences.map(s => s.text).join('\n');
  }

  private createCorrectionPrompt(targetSentence: string, context: string): string {
    return `
# 命令
あなたはテキスト校正のプロです。入力テキストをMarkDown形式で与えるので、校正してください。校正内容は日本語表記の校正と、MarkDownの校正です。

## 日本語表記の校正
記者ハンドブックをベースに、公用文のルールに従って、日本語表記のルールについてレビューを行ってください。例えば、以下のような文章の誤りを校正してください。

- 誤字
- 脱字
- 変換ミス
- 文体の不一致
- 不明瞭な修飾関係
- 不自然な日本語表現
- 不適切な文の接続

## MarkDownの校正
MarkDownの標準的な文法に従ってレビューを行ってください。

## 参考情報
校正のための参考情報として前後の文脈を与えます。前後の文脈は校正の対象ではありません。

# 前後の文脈

${context}

# 入力テキスト

${targetSentence}

# 注意
前後の文脈を参考に、入力テキストのみを校正してください。
前後の文脈の文章に誤りがあっても絶対に指摘しないでください。

# 出力形式
以下のスキーマを持つJSONで出力してください。

{
    "error": ["入力テキストの誤りの内容1", "入力テキストの誤りの内容2", ..., "入力テキストの誤りの内容n"],
    "correctedSentence": "問題点を修正した後の入力テキスト"
}

- 誤りが存在しない場合はerrorは空のリストにして、correctedSentenceには元の文を出力してください
- 前後の文脈は参考情報なので、errorとcorrectedSentenceの内容は入力テキストのみにしてください
- correctedSentenceはMarkDown形式で記述してください
- 入力テキストがMarkDownの記号を含む場合、correctedSentenceにも対応する記号を含めてください。特に、文頭のリスト記号は保持してください
`;
  }

  
  private async callOpenAIAPI(prompt: string): Promise<{ error: string[], correctedSentence: string }> {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: "あなたは優秀なテキスト処理のアシスタントです。JSONで結果を出力します。"
            },
            {
                role: "user",
                content: prompt
            }
        ],
        response_format: {
            type: "json_object"
        }
      });

      const content = response.choices[0].message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      return JSON.parse(content);
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
      return { error: [], correctedSentence: '' };
    }
  }
}

export async function* proofread(text: string, apiKey: string): AsyncIterableIterator<CorrectionResult> {
  const processor = new TextProcessor(apiKey);
  const sentences = await processor.processParagraphs(text);
  yield* processor.correctTextStream(sentences);
}
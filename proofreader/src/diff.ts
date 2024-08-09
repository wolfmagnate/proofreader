export type DiffPart = {type: 'equal' | 'insert' | 'delete', value: string};

export function computeDiff(text1: string, text2: string): DiffPart[] {
    const m = text1.length;
    const n = text2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    // LCSの長さを計算
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (text1[i - 1] === text2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // 差分を再構築
    const diff: DiffPart[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && text1[i - 1] === text2[j - 1]) {
            diff.unshift({type: 'equal', value: text1[i - 1]});
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift({type: 'insert', value: text2[j - 1]});
            j--;
        } else {
            diff.unshift({type: 'delete', value: text1[i - 1]});
            i--;
        }
    }

    return mergeDiff(diff);
}

function mergeDiff(diff: DiffPart[]): DiffPart[] {
    const merged: DiffPart[] = [];
    let current: DiffPart | null = null;

    for (const part of diff) {
        if (current === null || current.type !== part.type) {
            if (current !== null) {
                merged.push(current);
            }
            current = {...part};
        } else {
            current.value += part.value;
        }
    }

    if (current !== null) {
        merged.push(current);
    }

    return merged;
}
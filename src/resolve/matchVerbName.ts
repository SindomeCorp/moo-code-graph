type StarState = "none" | "inner" | "end";

export function matchesVerbName(pattern: string, selector: string): boolean {
  return matchesVerbAliasList(pattern, selector);
}

function matchesVerbAliasList(pattern: string, selector: string): boolean {
  const verb = pattern.toLowerCase();
  const word = selector.toLowerCase();
  let v = 0;

  while (v < verb.length) {
    let w = 0;
    let star: StarState = "none";

    while (true) {
      while (verb[v] === "*") {
        v += 1;
        star = v >= verb.length || verb[v] === " " ? "end" : "inner";
      }

      if (v >= verb.length || verb[v] === " " || w >= word.length || word[w] !== verb[v]) {
        break;
      }

      w += 1;
      v += 1;
    }

    if (w >= word.length ? star !== "none" || v >= verb.length || verb[v] === " " : star === "end") {
      return true;
    }

    while (v < verb.length && verb[v] !== " ") v += 1;
    while (v < verb.length && verb[v] === " ") v += 1;
  }

  return false;
}

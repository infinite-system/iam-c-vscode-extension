function init({ typescript: ts }) {
  function create(info) {
    const proxy = Object.create(null);
    Object.assign(proxy, info.languageService);

    proxy.getSemanticTokens = (fileName) => {
      const tokens = info.languageService.getSemanticTokens(fileName);
      if (!tokens) return tokens;

      const program = info.languageService.getProgram();
      if (!program) return tokens;
      const checker = program.getTypeChecker();
      const source = program.getSourceFile(fileName);

      for (let i = 0; i < tokens.length; i += 5) {
        const start = tokens[i];
        const len = tokens[i+1];
        const text = source.getFullText().slice(start, start+len);
        if (text !== "value") continue;

        const node = locate(source, start, ts);
        if (!node || !ts.isIdentifier(node) || !ts.isPropertyAccessExpression(node.parent)) continue;

        const objType = checker.getTypeAtLocation(node.parent.expression);
        const symbol = objType?.symbol?.escapedName;
        if (symbol === "Ref" || symbol === "ComputedRef") tokens[i+2] = 255;
      }

      return tokens;
    };

    return proxy;
  }

  function locate(root, pos, ts) {
    function walk(node) {
      if (pos >= node.getStart() && pos < node.getEnd())
        return ts.forEachChild(node, walk) || node;
    }
    return walk(root);
  }

  return { create };
}

module.exports = init;
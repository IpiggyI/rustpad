# 评审目标 — Round 1(review 模式)

baseline:    e00e183 @ 2026-06-26T01:51:28Z , scope: working-tree
diff-id:     7ea1aee52dac0a963e2e88efef60ba6bef3b64708a0f8fea219f555bc1464edd
coverage:    full-diff
omitted:     none
blind-spots: 移动端真机事件时序未抓取(粘贴修复按「event.changes 不可信」这一类问题做结构性鲁棒,而非真机复现);抽屉的视觉/手感未在真机验证

## 评审范围
working-tree vs HEAD,4 文件:
- `src/rustpad.ts` — 同步引擎 `onChange` 重写 + 新增代理对 helper。
- `src/Sidebar.tsx` / `src/SingleDocView.tsx` / `src/BlockPageView.tsx` — 侧边栏覆盖式抽屉 + 遮罩 + 默认折叠。

## 两处改动要点
1. **粘贴失同步:** `onChange` 不再信任 `event.changes`,改为对 `lastValue` 与 `model.getValue()` 求公共前缀/后缀最小 diff(UTF-16 码点计长、避开代理对接缝),生成 `retain(prefix) delete(changed) insert(new) retain(suffix)`。构造器接线从 `(e)=>this.onChange(e)` 改为 `()=>this.onChange()`。新增 `isHighSurrogate`/`isLowSurrogate`。设计意图:base_len 恒等于 `lastValue` 的码点数,与 server `apply_edit` 契合,免疫移动端事件不忠实。
2. **侧边栏抽屉:** 移除 `display={{ base:"none", sm:"block" }}`;侧栏改 `position={{ base:"absolute", sm:"static" }}` + `top/bottom/left:0`(仅 base)+ `zIndex:20`(仅 base)浮动;新增半透明 `Box` 遮罩(`display base:block / sm:none`,`zIndex:10`,点击 `toggleSidebar` 关闭);外层 `Flex` 加 `position="relative"`;`sidebarCollapsed` 默认值 `false` → `() => window.innerWidth < 480`(仅首访生效)。

## 自检结论(待复核)
- `npm run check`(tsc):通过。
- `npm run build`(vite):通过,1051 模块。
- diff 算法独立脚本 13/13:emoji 代理对、CJK、换行、多区域合并、整段粘贴均满足 `base_len=旧码点数`、`target_len=新码点数`、应用后等于新值。

## 完整 diff(payload,diff-id 即其 sha256)

```diff
diff --git a/src/BlockPageView.tsx b/src/BlockPageView.tsx
index ea82adc..b495d84 100644
--- a/src/BlockPageView.tsx
+++ b/src/BlockPageView.tsx
@@ -83,7 +83,7 @@ function BlockPageView({
 
   const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
     "sidebarCollapsed",
-    { defaultValue: false },
+    { defaultValue: () => window.innerWidth < 480 },
   );
   const [wordWrap, setWordWrap] = useLocalStorageState("wordWrap", {
     defaultValue: false,
@@ -345,11 +345,15 @@ function BlockPageView({
   }
 
   return (
-    <Flex flex="1 0" minH={0}>
+    <Flex flex="1 0" minH={0} position="relative">
       {!sidebarCollapsed && (
         <Container
           w={{ base: "3xs", md: "2xs", lg: "xs" }}
-          display={{ base: "none", sm: "block" }}
+          position={{ base: "absolute", sm: "static" }}
+          top={{ base: 0, sm: "auto" }}
+          bottom={{ base: 0, sm: "auto" }}
+          left={{ base: 0, sm: "auto" }}
+          zIndex={{ base: 20, sm: "auto" }}
           bgColor={darkMode ? "#252526" : "#f3f3f3"}
           overflowY="auto"
           maxW="full"
@@ -471,6 +475,17 @@ function BlockPageView({
         </Container>
       )}
 
+      {!sidebarCollapsed && (
+        <Box
+          display={{ base: "block", sm: "none" }}
+          position="absolute"
+          inset={0}
+          zIndex={10}
+          bgColor="blackAlpha.500"
+          onClick={toggleSidebar}
+        />
+      )}
+
       <Flex flex={1} minW={0} h="100%" direction="column" overflow="hidden">
         <HStack
           h={6}
diff --git a/src/Sidebar.tsx b/src/Sidebar.tsx
index 99feddf..9b8cd5b 100644
--- a/src/Sidebar.tsx
+++ b/src/Sidebar.tsx
@@ -91,7 +91,11 @@ function Sidebar({
   return (
     <Container
       w={{ base: "3xs", md: "2xs", lg: "xs" }}
-      display={{ base: "none", sm: "block" }}
+      position={{ base: "absolute", sm: "static" }}
+      top={{ base: 0, sm: "auto" }}
+      bottom={{ base: 0, sm: "auto" }}
+      left={{ base: 0, sm: "auto" }}
+      zIndex={{ base: 20, sm: "auto" }}
       bgColor={darkMode ? "#252526" : "#f3f3f3"}
       overflowY="auto"
       maxW="full"
diff --git a/src/SingleDocView.tsx b/src/SingleDocView.tsx
index b0423f3..3ecc10c 100644
--- a/src/SingleDocView.tsx
+++ b/src/SingleDocView.tsx
@@ -60,7 +60,7 @@ function SingleDocView({
   const [editor, setEditor] = useState<editor.IStandaloneCodeEditor>();
   const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
     "sidebarCollapsed",
-    { defaultValue: false },
+    { defaultValue: () => window.innerWidth < 480 },
   );
   const [wordWrap, setWordWrap] = useLocalStorageState("wordWrap", {
     defaultValue: false,
@@ -241,7 +241,7 @@ function SingleDocView({
   }
 
   return (
-    <Flex flex="1 0" minH={0}>
+    <Flex flex="1 0" minH={0} position="relative">
       {!sidebarCollapsed && (
         <Sidebar
           documentId={id}
@@ -264,6 +264,16 @@ function SingleDocView({
           onChangeDocumentTitle={handleDocumentTitleChange}
         />
       )}
+      {!sidebarCollapsed && (
+        <Box
+          display={{ base: "block", sm: "none" }}
+          position="absolute"
+          inset={0}
+          zIndex={10}
+          bgColor="blackAlpha.500"
+          onClick={toggleSidebar}
+        />
+      )}
       <ReadCodeConfirm
         isOpen={readCodeConfirmOpen}
         onClose={() => setReadCodeConfirmOpen(false)}
diff --git a/src/rustpad.ts b/src/rustpad.ts
index 25ca5cb..bcf2ec8 100644
--- a/src/rustpad.ts
+++ b/src/rustpad.ts
@@ -60,8 +60,8 @@ class Rustpad {
   constructor(readonly options: RustpadOptions) {
     this.model = options.editor.getModel()!;
     this.lastValue = this.model.getValue();
-    this.onChangeHandle = options.editor.onDidChangeModelContent((e) =>
-      this.onChange(e),
+    this.onChangeHandle = options.editor.onDidChangeModelContent(() =>
+      this.onChange(),
     );
     const cursorUpdate = debounce(() => this.sendCursorData(), 20);
     this.onCursorHandle = options.editor.onDidChangeCursorPosition((e) => {
@@ -421,37 +421,57 @@ class Rustpad {
     );
   }
 
-  private onChange(event: editor.IModelContentChangedEvent) {
-    if (!this.ignoreChanges) {
-      const content = this.lastValue;
-      const contentLength = unicodeLength(content);
-      let offset = 0;
-
-      let operation = OpSeq.new();
-      operation.retain(contentLength);
-      event.changes.sort((a, b) => b.rangeOffset - a.rangeOffset);
-      for (const change of event.changes) {
-        // The following dance is necessary to convert from UTF-16 indices (evil
-        // encoding-dependent JavaScript representation) to portable Unicode
-        // codepoint indices.
-        const { text, rangeOffset, rangeLength } = change;
-        const initialLength = unicodeLength(content.slice(0, rangeOffset));
-        const deletedLength = unicodeLength(
-          content.slice(rangeOffset, rangeOffset + rangeLength),
-        );
-        const restLength =
-          contentLength + offset - initialLength - deletedLength;
-        const changeOp = OpSeq.new();
-        changeOp.retain(initialLength);
-        changeOp.delete(deletedLength);
-        changeOp.insert(text);
-        changeOp.retain(restLength);
-        operation = operation.compose(changeOp)!;
-        offset += changeOp.target_len() - changeOp.base_len();
-      }
-      this.applyClient(operation);
-      this.lastValue = this.model.getValue();
+  private onChange() {
+    if (this.ignoreChanges) return;
+
+    // Rebuild the operation by diffing the previous value against the current
+    // model value, rather than trusting Monaco's `event.changes`. On mobile,
+    // IME/composition delivers pasted and typed text as a series of change
+    // events that do not faithfully describe the delta from `lastValue`, which
+    // would yield an operation with a mismatched base length and desynchronize
+    // the client. A common prefix/suffix diff always produces a valid operation
+    // that maps `lastValue` to the new model value.
+    const oldValue = this.lastValue;
+    const newValue = this.model.getValue();
+    if (oldValue === newValue) return;
+
+    // Common prefix/suffix in UTF-16 code units, kept off surrogate-pair seams.
+    const maxPrefix = Math.min(oldValue.length, newValue.length);
+    let prefix = 0;
+    while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) {
+      prefix++;
     }
+    if (prefix > 0 && isHighSurrogate(oldValue.charCodeAt(prefix - 1))) {
+      prefix--;
+    }
+
+    const maxSuffix = Math.min(oldValue.length, newValue.length) - prefix;
+    let suffix = 0;
+    while (
+      suffix < maxSuffix &&
+      oldValue[oldValue.length - 1 - suffix] ===
+        newValue[newValue.length - 1 - suffix]
+    ) {
+      suffix++;
+    }
+    if (
+      suffix > 0 &&
+      isLowSurrogate(oldValue.charCodeAt(oldValue.length - suffix))
+    ) {
+      suffix--;
+    }
+
+    const deleted = oldValue.slice(prefix, oldValue.length - suffix);
+    const inserted = newValue.slice(prefix, newValue.length - suffix);
+
+    const operation = OpSeq.new();
+    operation.retain(unicodeLength(oldValue.slice(0, prefix)));
+    operation.delete(unicodeLength(deleted));
+    operation.insert(inserted);
+    operation.retain(unicodeLength(oldValue.slice(oldValue.length - suffix)));
+
+    this.applyClient(operation);
+    this.lastValue = newValue;
   }
 
   private onCursor(event: editor.ICursorPositionChangedEvent) {
@@ -504,6 +524,16 @@ function unicodeLength(str: string): number {
   return length;
 }
 
+/** Returns whether a UTF-16 code unit is the high half of a surrogate pair. */
+function isHighSurrogate(code: number): boolean {
+  return code >= 0xd800 && code <= 0xdbff;
+}
+
+/** Returns whether a UTF-16 code unit is the low half of a surrogate pair. */
+function isLowSurrogate(code: number): boolean {
+  return code >= 0xdc00 && code <= 0xdfff;
+}
+
 /** Returns the number of Unicode codepoints before a position in the model. */
 function unicodeOffset(model: editor.ITextModel, pos: IPosition): number {
   const value = model.getValue();
```

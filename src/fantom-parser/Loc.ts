// Loc provides a source file, line number, and column number.
export class Loc {
  file: string | null = "Unknown";
  line: number | null;
  col: number | null;

  constructor(
    file: string | null,
    line: number | null = null,
    col: number | null = null
  ) {
    this.file = file;
    this.line = line;
    this.col = col;
  }

  static makeUninit(): Loc {
    const loc = Object.create(Loc.prototype);
    loc.file = "Unknown";
    loc.line = null;
    loc.col = null;
    return loc;
  }

  //? override Int hash()
  //? {
  //?   let hash = this.file.hash
  //?   if (line != null) hash = hash.xor(line.hash)
  //?   if (col  != null) hash = hash.xor(col.hash)
  //?   return hash
  //? }

  //? override Bool equals(Obj? that)
  //? {
  //?   x := that as Loc
  //?   if (x == null) return false
  //?   return file == x.file && line == x.line && col == x.col
  //? }

  //? override Int compare(Obj that)
  //? {
  //?   x := (Loc)that
  //?   if (file != x.file) return file <=> x.file
  //?   if (line != x.line) return line <=> x.line
  //?   return col <=> x.col
  //? }

  //? override Str toStr()
  //? {
  //?   return toLocStr
  //? }

  //? Str toLocStr()
  //? {
  //?   StrBuf s := StrBuf()
  //?   s.add(file)
  //?   if (line != null)
  //?   {
  //?     s.add("(").add(line)
  //?     if (col != null) s.add(",").add(col)
  //?     s.add(")")
  //?   }
  //?   return s.toStr
  //? }
}

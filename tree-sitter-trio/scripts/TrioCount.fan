using haystack
class TrioCount
{
  static Void main(Str[] args)
  {
    File.os(args[0]).readAllLines.each |f|
    {
      if (f.trim.isEmpty) return
      try
      {
        dicts := TrioReader(File.os(f).in).readAllDicts
        tags := 0
        names := StrBuf()
        dicts.each |d| { d.each |v, n| { tags++; names.add(n).add(",") }; names.add("|") }
        crc := names.toStr.toBuf.crc("CRC-32"); echo("$f\t${dicts.size}\t$tags\t$crc")
      }
      catch (Err e) echo("$f\tERR")
    }
  }
}

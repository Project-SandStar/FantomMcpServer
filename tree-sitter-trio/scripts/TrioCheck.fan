using haystack
class TrioCheck
{
  static Void main(Str[] args)
  {
    list := File.os(args[0]).readAllLines
    ok := 0; bad := 0
    list.each |f|
    {
      if (f.trim.isEmpty) return
      try { TrioReader(File.os(f).in).readAllDicts; ok++ }
      catch (Err e) { bad++; echo("ERR $f: ${e.msg} CAUSE=${e.cause?.msg}") }
    }
    echo("ok=$ok bad=$bad")
  }
}

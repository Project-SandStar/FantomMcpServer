using sys

**
** Example Fantom class
**
class Hello {
  Str name := "World"

  new make(Str name := "World") {
    this.name = name
  }

  Void greet() {
    echo("Hello, $name!")
  }

  static Void main(Str[] args) {
    hello := Hello()
    hello.greet()
  }
}

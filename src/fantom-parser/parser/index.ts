import { Loc } from "../Loc";
import { Parser } from "./Parser";
import { Tokenizer } from "./Tokenizer";
import fs from "node:fs";
import { TokenVal } from "./TokenVal";

let exampleFile: string;
let tokens: TokenVal[];

exampleFile = fs.readFileSync(`${__dirname}/../../../fan/example.fan`, "utf-8");

if (!exampleFile) {
  console.log("No file found. Please create the 'example.fan' file with code");
}

let tokenizer = new Tokenizer(
  new Loc(`${__dirname}/../../../fan/example.fan`),
  exampleFile,
  true
);

tokens = tokenizer.tokenize();

fs.writeFileSync(
  `${__dirname}/../../../fan/tokens.json`,
  JSON.stringify(tokens),
  { encoding: "utf-8" }
);

let parser = new Parser(tokens, tokens.length);

parser.parse();

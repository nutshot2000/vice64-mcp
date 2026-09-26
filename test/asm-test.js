import { assemble } from "../src/asm6502.js";
import { disassemble } from "../src/c64.js";
const src = `
        * = $0801
        .basic start
ZP = $fb
start:  ldx #$ff
        txs
@loop:  lda table,x
        sta $d020
        sta ZP
        lda (ZP),y
        lda (ZP,x)
        jmp (vec)
        lsr
        asl a
        inc count,x
        ldx fwd,y
        bne @loop
        lda #<table
        ldy #>table
        rts
count:  .byte 1, -1, 'A', %1010, <start, >start
vec:    .word start, *+2
        .scr "HI@"
        .text "hi{clr}"
        .bits "..####..########........"
        .fill 3, $ea
fwd = $40
table:
`;
const r = assemble(src);
console.log(`$${r.start.toString(16)}-$${r.end.toString(16)} entry $${r.entry.toString(16)} stub=${r.hasBasicStub}`);
console.log(r.bytes.subarray(0, 13).toString("hex"));
console.log(disassemble(r.bytes.subarray(13), r.start + 13, 17).lines.join("\n"));
console.log("data", r.bytes.subarray(r.symbols.count - r.start).toString("hex"));
try { assemble("  bne far\n  .fill 200\nfar: rts"); } catch (e) { console.log("expected error:", e.message); }
try { assemble("  lda #1\n  foo\n"); } catch (e) { console.log("expected error:", e.message); }

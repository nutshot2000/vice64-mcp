; ============================================================
;  NEON RAID - a C64 vertical shoot 'em up
;  Waves on flight paths, power-up capsules, boss fights.
;  Keyboard (redefinable) or joystick in port 2.
;  Built with vice-mcp's vice_assemble.
; ============================================================

SCREEN  = $0400
COLRAM  = $d800
SPRPTR  = SCREEN+$3f8
NE      = 6             ; enemy slots -> sprites 2..7
NB      = 20            ; bullet slots: 0..9 player, 10..19 enemy
NPB     = 10
NSTARS  = 24
STARMAX = 184           ; 23 star rows * 8 sub-steps
TOPY    = 67            ; sprite y just below the HUD divider
PBCHAR  = 93            ; player shot: vertical bar
SPCHAR  = 90            ; player spread shot: diamond
EBCHAR  = 81            ; enemy bullet: ball
KEY_F1  = 4

; ---------------- zero page ----------------
frame   = $02
seed    = $03
state   = $04           ; 0 title, 1 playing, 2 game over
px      = $05
py      = $06
weapon  = $07           ; 0 single, 1 double, 2 triple, 3 quad
pspeed  = $08           ; pixels per frame (2..4)
shield  = $09
firecd  = $0a
wave    = $0b           ; 2 bytes: current position in the stage script
lives   = $0d
stage   = $0e
wstate  = $0f           ; 0 spawning, 1 waiting, 2 boss
invuln  = $10
score   = $11           ; 3 bytes BCD, most significant first
hiscore = $14
joy     = $17
joyprev = $18
tmp     = $19
tmp2    = $1a
sfxlas  = $1b
sfxexp  = $1c
beat    = $1d
dead    = $1e
note    = $1f
w_left  = $20
w_timer = $21
w_type  = $22
w_path  = $23
w_space = $24
w_x     = $25
w_mir   = $26
w_delay = $27
w_grp   = $28
cap_act = $29
cap_x   = $2a
cap_y   = $2b
cap_typ = $2c
cap_t   = $2d
boss_x  = $2e
boss_y  = $2f
boss_hp = $30
boss_dir = $31
boss_t  = $32
boss_st = $33           ; 0 none, 1 warping in, 2 fighting, 3 exploding
boss_fl = $34
boss_pat = $35
lastkx  = $36
lastky  = $37
grp_alive = $38         ; 4 groups each
grp_kill = $3c
grp_cnt = $40
grp_done = $44
stx     = $48           ; star arrays, NSTARS bytes each
sty     = $60
sts     = $78
sprx    = $90           ; logical sprite positions (8 each)
spry    = $98
zp_c    = $a3
sb_x    = $a5           ; bullet spawn parameters
sb_y    = $a6
sb_vx   = $a7
sb_vy   = $a8
sc_lo   = $a9           ; score to add (BCD)
sc_mid  = $aa
tmp4    = $ab
bspeed  = $ac           ; enemy bullet fall speed
firebon = $ad           ; extra enemy fire chance per stage
tempo   = $ae
sfxup   = $af
flash   = $bc
flashc  = $bd
lasfreq = $c0
expfreq = $c1
timer   = $c2
bannert = $c3
keycodes = $c4          ; 5 matrix codes (col*8+row): left, right, up, down, fire
kcol    = $c9
krow    = $ce
rd_i    = $d3
tmp3    = $d4
zp_ptr  = $f7
zp_col  = $f9
zp_ptr2 = $fb
zp_t    = $fd

; ---------------- object tables (RAM at $c000) ----------------
e_type  = $c000
e_x     = e_type+NE
e_xf    = e_x+NE
e_y     = e_xf+NE
e_yf    = e_y+NE
e_vxl   = e_yf+NE
e_vxh   = e_vxl+NE
e_vyl   = e_vxh+NE
e_vyh   = e_vyl+NE
e_pl    = e_vyh+NE
e_ph    = e_pl+NE
e_t     = e_ph+NE
e_mir   = e_t+NE
e_state = e_mir+NE      ; 0 free, 1 alive, 2+ exploding countdown
e_hp    = e_state+NE
e_grp   = e_hp+NE
e_flash = e_grp+NE
b_act   = $c100
b_x     = b_act+NB
b_y     = b_x+NB
b_vx    = b_y+NB
b_vy    = b_vx+NB
b_col   = b_vy+NB
b_row   = b_col+NB
b_ch    = b_row+NB

; ============================================================
        * = $0801
        .basic start

start:
        sei
        ldx #$ff
        txs
        lda #$7f                ; no CIA interrupts: we own the machine
        sta $dc0d
        sta $dd0d
        lda $dc0d
        lda $dd0d
        lda #0
        sta $dc02
        sta $dc03
        sta $d020
        sta $d021
        sta $d017
        sta $d01d
        sta $d01c
        sta $d01b
        lda #$ff
        sta $d015
        lda $d012
        ora #1
        sta seed
        lda #0
        sta hiscore
        sta hiscore+1
        sta hiscore+2
        lda #0                  ; object tables start out as random RAM
        tax
@clr:   sta $c000,x
        sta $c100,x
        inx
        bne @clr
        lda #$ff
        ldx #NB-1
@brow:  sta b_row,x
        dex
        bpl @brow
        ldx #4                  ; default keys: O P Q A SPACE
@keys:  lda default_keys,x
        sta keycodes,x
        dex
        bpl @keys
        jsr apply_keys
        jsr sid_init
        jmp title

; ============================================================
;  TITLE
; ============================================================
title:
        ldx #$ff
        txs
        lda #0
        sta state
        jsr clear_screen
        jsr clear_objects
        jsr init_stars
        jsr draw_logo
        lda #<txt_fire
        ldy #>txt_fire
        jsr print_rec
        lda #<txt_labels
        ldy #>txt_labels
        jsr print_rec
        jsr draw_keynames
        lda #<txt_f1
        ldy #>txt_f1
        jsr print_rec
        lda #<txt_joy
        ldy #>txt_joy
        jsr print_rec
        lda #<txt_hi
        ldy #>txt_hi
        jsr print_rec
        lda #<txt_credit
        ldy #>txt_credit
        jsr print_rec
        lda #<(SCREEN+23*40+19)
        sta zp_ptr
        lda #>(SCREEN+23*40+19)
        sta zp_ptr+1
        ldx #hiscore
        jsr print_bcd
@loop:  jsr title_frame
        lda frame               ; blink "PRESS FIRE"
        and #16
        beq @dim
        lda #1
        bne @set
@dim:   lda #11
@set:   ldx #18
@blink: sta COLRAM+15*40+10,x
        dex
        bpl @blink
        jsr scan_any            ; F1 = redefine keys
        cmp #KEY_F1
        bne @nof1
        jmp redefine
@nof1:  jsr read_joy
        lda joyprev
        eor #$ff
        and joy
        and #$10
        beq @loop
        jmp new_game

title_frame:
        jsr wait_frame
        jsr move_stars
        jsr color_logo
        jsr sound_update
        inc frame
        rts

; ============================================================
;  REDEFINE KEYS
; ============================================================
redefine:
        ldx #$ff
        txs
        jsr clear_menu
        lda #<txt_redef
        ldy #>txt_redef
        jsr print_rec
        lda #<txt_labels
        ldy #>txt_labels
        jsr print_rec
        lda #$ff
        ldx #4
@clr:   sta keycodes,x
        dex
        bpl @clr
        lda #0
        sta rd_i
@ask:   jsr draw_keynames
        lda #<txt_press
        ldy #>txt_press
        jsr print_rec
        ldx rd_i
        lda act_lo,x
        ldy act_hi,x
        jsr print_rec
@rel:   jsr title_frame
        jsr scan_any
        cmp #$ff
        bne @rel
@wait:  jsr title_frame
        jsr scan_any
        cmp #$ff
        beq @wait
        sta tmp3
        ldx rd_i
        dex
        bmi @ok
@dup:   lda keycodes,x
        cmp tmp3
        beq @wait
        dex
        bpl @dup
@ok:    ldx rd_i
        lda tmp3
        sta keycodes,x
        jsr sfx_laser
        inc rd_i
        lda rd_i
        cmp #5
        bne @ask
        jsr apply_keys
        jsr draw_keynames
        lda #<txt_done
        ldy #>txt_done
        jsr print_rec
@fin:   jsr title_frame
        jsr scan_any
        cmp #$ff
        bne @fin
        lda #50
        sta timer
@pause: jsr title_frame
        dec timer
        bne @pause
        jmp title

; ============================================================
;  GAME
; ============================================================
new_game:
        ldx #$ff
        txs
        lda #1
        sta state
        sta stage
        lda #0
        sta score
        sta score+1
        sta score+2
        sta dead
        sta sfxlas
        sta flash
        sta beat
        sta note
        lda #3
        sta lives
        jsr clear_screen
        jsr clear_objects
        jsr init_stars
        jsr draw_hud
        jsr reset_player
        lda #0
        sta weapon
        lda #2
        sta pspeed
        jsr start_stage
        lda #<txt_ready
        ldy #>txt_ready
        jsr show_banner

game_loop:
        jsr wait_frame
        jsr update_sprites
        jsr do_flash
        lda boss_st
        cmp #2
        bne @div
        jsr draw_boss_bar
        jmp @bar
@div:   jsr cycle_divider
@bar:   jsr update_banner
        jsr move_stars
        jsr read_joy
        jsr move_player
        jsr player_fire
        jsr wave_update
        jsr move_enemies
        jsr boss_update
        jsr move_capsule
        jsr move_bullets
        jsr collisions
        jsr sound_update
        jsr draw_hud_values
        inc frame
        jmp game_loop

reset_player:
        lda #116
        sta px
        lda #210
        sta py
        lda #120
        sta invuln
        lda #0
        sta shield
        sta firecd
        lda #SP_SHIP
        sta SPRPTR
        lda #$1b
        sta $d011
        rts

; free every enemy, bullet, capsule and the boss
clear_objects:
        ldx #NB-1
@b:     lda b_act,x
        beq @bn
        jsr erase_bullet
        lda #0
        sta b_act,x
@bn:    lda #$ff
        sta b_row,x
        dex
        bpl @b
        lda #0
        ldx #NE-1
@e:     sta e_state,x
        dex
        bpl @e
        sta cap_act
        sta boss_st
        sta $d017
        sta $d01d
        ldx #3
@g:     sta grp_alive,x
        sta grp_done,x
        dex
        bpl @g
        jmp hide_sprites

; ------------------------------------------------------------
;  stage script
; ------------------------------------------------------------
start_stage:
        lda #<stage_script
        sta wave
        lda #>stage_script
        sta wave+1
        lda #1
        sta wstate
        lda #100
        sta w_timer
        lda stage               ; difficulty
        sec
        sbc #1
        sta tmp
        asl
        adc tmp
        sta firebon             ; +3 fire chance per stage
        lda #2
        ldx stage
        cpx #3
        bcc @bs
        lda #3
@bs:    sta bspeed
        lda #12
        sta tempo
        rts

wave_update:
        lda wstate
        cmp #2
        bcc @go
        rts
@go:    lda w_timer
        beq @tick
        dec w_timer
        rts
@tick:  lda wstate
        bne @next
        lda w_left              ; spawning a wave
        beq @endw
        jsr spawn_from_wave
        bcs @r                  ; no free slot: try again next frame
        dec w_left
        lda w_space
        sta w_timer
@r:     rts
@endw:  ldx w_grp
        lda #1
        sta grp_done,x
        jsr check_group
        lda w_delay
        sta w_timer
        lda #1
        sta wstate
        rts
@next:  ldy #0                  ; read the next wave record
        lda (wave),y
        cmp #$ff
        bne @load
        lda #2
        sta wstate
        jmp boss_start
@load:  sta w_type
        iny
        lda (wave),y
        sta w_path
        iny
        lda (wave),y
        sta w_left
        iny
        lda (wave),y
        sta w_space
        iny
        lda (wave),y
        sta w_x
        iny
        lda (wave),y
        sta w_mir
        iny
        lda (wave),y
        sta w_delay
        lda wave
        clc
        adc #7
        sta wave
        bcc @nc
        inc wave+1
@nc:    lda w_grp               ; new formation group
        clc
        adc #1
        and #3
        sta w_grp
        tax
        lda #0
        sta grp_alive,x
        sta grp_kill,x
        sta grp_done,x
        lda w_left
        sta grp_cnt,x
        lda #0
        sta wstate
        sta w_timer
        rts

; a group is finished: if every member was shot down, drop a power-up
check_group:
        lda grp_done,x
        beq @r
        lda grp_alive,x
        bne @r
        lda #0
        sta grp_done,x
        lda grp_kill,x
        cmp grp_cnt,x
        bne @r
        jsr spawn_capsule
@r:     rts

; ------------------------------------------------------------
;  enemies
; ------------------------------------------------------------
; C set = no free slot
spawn_from_wave:
        ldx #NE-1
@f:     lda e_state,x
        beq @got
        dex
        bpl @f
        sec
        rts
@got:   lda w_type
        ldy w_path
        jsr spawn_enemy
        lda w_x
        sta e_x,x
        lda w_mir
        sta e_mir,x
        jsr load_seg
        lda w_grp
        sta e_grp,x
        stx tmp4
        tax
        inc grp_alive,x
        ldx tmp4
        clc
        rts

; x = slot, a = type, y = path
spawn_enemy:
        sta e_type,x
        lda path_lo,y
        sta e_pl,x
        lda path_hi,y
        sta e_ph,x
        lda #30
        sta e_y,x
        lda #0
        sta e_xf,x
        sta e_yf,x
        sta e_flash,x
        sta e_mir,x
        sta e_vxl,x
        sta e_vxh,x
        sta e_vyl,x
        sta e_vyh,x
        lda #4                  ; group 4 = not part of a formation
        sta e_grp,x
        ldy e_type,x
        lda type_hp,y
        sta e_hp,x
        lda #1
        sta e_state,x
        rts

; load the next path segment for enemy x (velocities are 1/16 pixel per frame)
load_seg:
        lda e_pl,x
        sta zp_t
        lda e_ph,x
        sta zp_t+1
        ldy #2
        lda (zp_t),y
        bne @seg
        lda #255                ; end of path: keep flying this way
        sta e_t,x
        rts
@seg:   sta e_t,x
        ldy #0
        lda (zp_t),y
        sta tmp4
        lda e_mir,x             ; mirrored formations fly the other way
        beq @nm
        lda #0
        sec
        sbc tmp4
        sta tmp4
@nm:    lda tmp4
        jsr split_vel
        sta e_vxl,x
        tya
        sta e_vxh,x
        ldy #1
        lda (zp_t),y
        jsr split_vel
        sta e_vyl,x
        tya
        sta e_vyh,x
        lda e_pl,x
        clc
        adc #3
        sta e_pl,x
        bcc @r
        inc e_ph,x
@r:     rts

; a = signed velocity in 1/16 px -> a = fraction (v<<4), y = whole part (v>>4, signed)
split_vel:
        sta tmp3
        cmp #$80
        ror
        cmp #$80
        ror
        cmp #$80
        ror
        cmp #$80
        ror
        tay
        lda tmp3
        asl
        asl
        asl
        asl
        rts

move_enemies:
        ldx #NE-1
@loop:  lda e_state,x
        bne @used
        jmp @hide
@used:  cmp #1
        beq @alive
        dec e_state,x           ; exploding
        lda e_state,x
        cmp #1
        bne @boom
        lda #0
        sta e_state,x
        jmp @hide
@boom:  lsr
        lsr
        and #1
        clc
        adc #SP_BOOM_A
        sta SPRPTR+2,x
        lda e_state,x
        and #2
        beq @y1
        lda #1
        bne @y2
@y1:    lda #7
@y2:    sta $d029,x
        jmp @pos
@alive: dec e_t,x
        bne @move
        jsr load_seg
@move:  clc
        lda e_xf,x
        adc e_vxl,x
        sta e_xf,x
        lda e_x,x
        adc e_vxh,x
        sta e_x,x
        cmp #3
        bcc @gone
        cmp #250
        bcs @gone
        clc
        lda e_yf,x
        adc e_vyl,x
        sta e_yf,x
        lda e_y,x
        adc e_vyh,x
        sta e_y,x
        cmp #20
        bcc @gone
        cmp #250
        bcs @gone
        ldy e_type,x            ; homing darts steer toward the player
        lda type_flags,y
        and #1
        beq @nohome
        lda e_y,x
        cmp py
        bcs @nohome
        lda e_x,x
        cmp px
        beq @nohome
        bcc @hr
        dec e_x,x
        jmp @nohome
@hr:    inc e_x,x
@nohome:
        lda frame
        lsr
        lsr
        lsr
        and #1
        clc
        adc type_spr,y
        sta SPRPTR+2,x
        lda e_flash,x
        beq @nc
        dec e_flash,x
        lda #1
        bne @sc
@nc:    lda type_col,y
@sc:    sta $d029,x
        jsr enemy_fire
@pos:   lda e_x,x
        sta sprx+2,x
        lda e_y,x
        cmp #TOPY
        bcs @show
        lda #0
@show:  sta spry+2,x
        jmp @next
@gone:  lda #0                  ; flew off screen
        sta e_state,x
        lda e_grp,x
        cmp #4
        bcs @hide
        stx tmp4
        tax
        dec grp_alive,x
        jsr check_group
        ldx tmp4
@hide:  lda #0
        sta spry+2,x
@next:  dex
        bmi @done
        jmp @loop
@done:  rts

; x = enemy (preserved)
enemy_fire:
        lda e_y,x
        cmp #TOPY+8
        bcc @r
        cmp #176
        bcs @r
        ldy e_type,x
        lda type_fire,y
        beq @r
        clc
        adc firebon
        sta tmp4
        jsr rnd
        cmp tmp4
        bcs @r
        lda e_x,x
        clc
        adc #8
        sta sb_x
        lda e_y,x
        clc
        adc #18
        sta sb_y
        lda bspeed
        sta sb_vy
        ldy e_type,x
        lda type_flags,y
        and #2
        bne @spread
        jsr aim_vx
        sta sb_vx
        jmp spawn_ebullet
@spread:
        lda #$ff
        sta sb_vx
        jsr spawn_ebullet
        lda #0
        sta sb_vx
        jsr spawn_ebullet
        lda #1
        sta sb_vx
        jmp spawn_ebullet
@r:     rts

; horizontal speed (-2..2) that roughly aims a bullet at sb_x toward the player
aim_vx:
        lda px
        clc
        adc #8
        sec
        sbc sb_x
        bcc @neg
        cmp #48
        bcs @p2
        cmp #14
        bcs @p1
        lda #0
        rts
@p2:    lda #2
        rts
@p1:    lda #1
        rts
@neg:   eor #$ff
        adc #1
        cmp #48
        bcs @m2
        cmp #14
        bcs @m1
        lda #0
        rts
@m2:    lda #$fe
        rts
@m1:    lda #$ff
        rts

; x = enemy hit by a shot
hit_enemy:
        dec e_hp,x
        beq kill_enemy
        lda #3
        sta e_flash,x
        lda #4
        jmp sfx_expl

; x = enemy destroyed
kill_enemy:
        lda #26
        sta e_state,x
        lda #16
        jsr sfx_expl
        lda e_x,x
        sta lastkx
        lda e_y,x
        sta lastky
        ldy e_type,x
        lda type_sclo,y
        sta sc_lo
        lda type_scmid,y
        sta sc_mid
        jsr add_score
        lda e_grp,x
        cmp #4
        bcs @r
        stx tmp4
        tax
        dec grp_alive,x
        inc grp_kill,x
        jsr check_group
        ldx tmp4
@r:     rts

; ------------------------------------------------------------
;  boss
; ------------------------------------------------------------
boss_start:
        lda #1
        sta boss_st
        lda #64
        sta boss_x
        lda #TOPY+4
        sta boss_y
        lda #1
        sta boss_dir
        lda #0
        sta boss_pat
        sta boss_fl
        lda stage               ; hp = 60 + 20 per stage (max 156)
        cmp #5
        bcc @s
        lda #5
@s:     asl
        asl
        sta tmp
        asl
        asl
        adc tmp
        adc #40
        sta boss_hp
        lda #90
        sta boss_t
        ldx #2                  ; free enemy slots 2..5 (their sprites become the boss)
        lda #0
@f:     sta e_state,x
        inx
        cpx #6
        bne @f
        lda #$f0                ; sprites 4-7 double size
        sta $d017
        sta $d01d
        lda #SP_BOSS_TL
        sta SPRPTR+4
        lda #SP_BOSS_TR
        sta SPRPTR+5
        lda #SP_BOSS_BL
        sta SPRPTR+6
        lda #SP_BOSS_BR
        sta SPRPTR+7
        lda #8
        sta tempo
        lda #<txt_warning
        ldy #>txt_warning
        jmp show_banner

boss_update:
        lda boss_st
        bne @on
        rts
@on:    cmp #1
        beq @enter
        cmp #3
        beq @dying
        lda boss_x              ; fighting: glide side to side
        clc
        adc boss_dir
        sta boss_x
        cmp #4
        bcc @flip
        cmp #156
        bcc @bob
@flip:  lda #0
        sec
        sbc boss_dir
        sta boss_dir
@bob:   lda frame               ; gentle bob
        and #63
        tay
        lda sine,y
        cmp #$80
        ror
        cmp #$80
        ror
        cmp #$80
        ror
        clc
        adc #84
        sta boss_y
        dec boss_t
        bne @draw
        jsr boss_attack
        jmp @draw
@enter: inc boss_y               ; warp in, flickering, invulnerable
        lda boss_y
        cmp #84
        bcc @e1
        dec boss_y
@e1:    dec boss_t
        bne @flick
        lda #2
        sta boss_st
        lda #40
        sta boss_t
        jmp @draw
@flick: lda boss_t
        and #2
        beq @draw
        jmp @hide
@dying: dec boss_t
        bne @dy
        jmp boss_defeated
@dy:    lda boss_t
        and #7
        bne @df
        lda #30
        jsr sfx_expl
        lda #6
        sta flash
        lda #7
        sta flashc
@df:    lda boss_t              ; everything explodes
        lsr
        lsr
        and #1
        clc
        adc #SP_BOOM_A
        sta SPRPTR+4
        sta SPRPTR+5
        sta SPRPTR+6
        sta SPRPTR+7
        lda boss_t
        and #2
        beq @dc1
        lda #7
        bne @dc2
@dc1:   lda #1
@dc2:   sta tmp
        jmp @place
@draw:  lda boss_fl              ; colour: white flash when hit
        beq @nf
        dec boss_fl
        lda #1
        bne @col
@nf:    lda #4
@col:   sta tmp
@place: lda tmp
        sta $d02b
        sta $d02c
        sta $d02d
        sta $d02e
        lda boss_x
        sta sprx+4
        sta sprx+6
        clc
        adc #48
        sta sprx+5
        sta sprx+7
        lda boss_y
        sta spry+4
        sta spry+5
        clc
        adc #42
        sta spry+6
        sta spry+7
        rts
@hide:  lda #0
        sta spry+4
        sta spry+5
        sta spry+6
        sta spry+7
        rts

boss_attack:
        inc boss_pat
        lda stage               ; faster attacks on later stages
        asl
        asl
        sta tmp
        lda #54
        sec
        sbc tmp
        cmp #24
        bcs @t
        lda #24
@t:     sta boss_t
        lda boss_y
        clc
        adc #78
        sta sb_y
        lda boss_pat
        and #3
        beq @aimed
        cmp #1
        beq @fan
        cmp #2
        beq @escort
        lda boss_x              ; twin cannons
        clc
        adc #14
        sta sb_x
        lda #0
        sta sb_vx
        lda bspeed
        clc
        adc #1
        sta sb_vy
        jsr spawn_ebullet
        lda boss_x
        clc
        adc #80
        sta sb_x
        jmp spawn_ebullet
@aimed: lda boss_x               ; three shots at the player
        clc
        adc #44
        sta sb_x
        lda bspeed
        sta sb_vy
        jsr aim_vx
        sta sb_vx
        jsr spawn_ebullet
        lda sb_vy
        clc
        adc #1
        sta sb_vy
        jsr spawn_ebullet
        inc sb_vy
        jmp spawn_ebullet
@fan:   lda boss_x               ; five-way fan
        clc
        adc #44
        sta sb_x
        lda bspeed
        sta sb_vy
        lda #$fe
        sta sb_vx
@fl:    jsr spawn_ebullet
        inc sb_vx
        lda sb_vx
        cmp #3
        bne @fl
        rts
@escort:
        ldx #1                  ; two kamikaze darts from slots 0/1
@es:    lda e_state,x
        bne @en
        lda #1
        ldy #PATH_DIVE
        jsr spawn_enemy
        lda boss_x
        clc
        adc esc_off,x
        sta e_x,x
        lda boss_y
        clc
        adc #40
        sta e_y,x
        jsr load_seg
@en:    dex
        bpl @es
        rts

boss_hit:
        lda boss_st
        cmp #2
        bne @r
        lda #2
        sta boss_fl
        lda #$10
        sta sc_lo
        lda #0
        sta sc_mid
        jsr add_score
        lda #3
        jsr sfx_expl
        dec boss_hp
        bne @r
        lda #3                  ; destroyed!
        sta boss_st
        lda #110
        sta boss_t
        lda #0
        sta sc_lo
        lda #$50
        sta sc_mid
        jsr add_score
        jsr clear_ebullets
@r:     rts

boss_defeated:
        lda #0
        sta boss_st
        sta $d017
        sta $d01d
        sta spry+4
        sta spry+5
        sta spry+6
        sta spry+7
        lda #12
        sta tempo
        lda stage
        cmp #9
        bcs @max
        inc stage
@max:   jsr draw_hud
        lda #<txt_clear
        ldy #>txt_clear
        jsr show_banner
        lda lastkx              ; the boss always drops a power-up
        pha
        lda boss_x
        clc
        adc #36
        sta lastkx
        lda boss_y
        clc
        adc #30
        sta lastky
        jsr spawn_capsule
        pla
        sta lastkx
        jmp start_stage

; divider row becomes the boss health bar
draw_boss_bar:
        lda boss_hp
        lsr
        lsr
        sta tmp
        ldx #39
@l:     cpx tmp
        bcs @empty
        lda #160
        sta SCREEN+40,x
        lda #2
        sta COLRAM+40,x
        jmp @n
@empty: lda #64
        sta SCREEN+40,x
        lda #11
        sta COLRAM+40,x
@n:     dex
        bpl @l
        rts

; ------------------------------------------------------------
;  power-up capsule: cycles P (weapon), S (speed), B (shield)
; ------------------------------------------------------------
spawn_capsule:
        lda cap_act
        bne @r
        lda #1
        sta cap_act
        lda lastkx
        sta cap_x
        lda lastky
        cmp #TOPY+4
        bcs @y
        lda #TOPY+4
@y:     sta cap_y
        lda #0
        sta cap_typ
        lda #60
        sta cap_t
@r:     rts

move_capsule:
        lda cap_act
        bne @go
        lda #0
        sta spry+1
        rts
@go:    lda frame
        and #1
        bne @s
        inc cap_y
@s:     lda cap_y
        cmp #246
        bcc @on
        lda #0
        sta cap_act
        sta spry+1
        rts
@on:    dec cap_t
        bne @same
        lda #60
        sta cap_t
        inc cap_typ
        lda cap_typ
        cmp #3
        bcc @same
        lda #0
        sta cap_typ
@same:  ldy cap_typ
        lda cap_spr,y
        sta SPRPTR+1
        lda frame
        and #4
        beq @c1
        lda #1
        bne @c2
@c1:    lda cap_col,y
@c2:    sta $d028
        lda cap_x
        sta sprx+1
        lda cap_y
        sta spry+1
        rts

collect_capsule:
        lda #0
        sta cap_act
        sta spry+1
        lda #0
        sta sc_lo
        lda #$05
        sta sc_mid
        jsr add_score
        jsr sfx_power
        ldy cap_typ
        beq @power
        dey
        beq @speed
        lda #1                  ; B: shield
        sta shield
        lda #<txt_shield
        ldy #>txt_shield
        jmp show_banner
@power: lda weapon
        cmp #3
        bcs @maxed
        inc weapon
@maxed: lda #<txt_power
        ldy #>txt_power
        jmp show_banner
@speed: lda pspeed
        cmp #4
        bcs @fast
        inc pspeed
@fast:  lda #<txt_speed
        ldy #>txt_speed
        jmp show_banner

; ------------------------------------------------------------
;  player
; ------------------------------------------------------------
move_player:
        lda dead
        beq @alive
        dec dead
        bne @dying
        lda lives
        bne @respawn
        jmp game_over
@respawn:
        jmp reset_player
@dying: lda dead                ; screen shake, explosion, then hidden
        cmp #72
        bcc @calm
        jsr rnd
        and #7
        ora #$18
        sta $d011
        jmp @anim
@calm:  lda #$1b
        sta $d011
@anim:  lda dead
        cmp #60
        bcc @hide
        lsr
        lsr
        and #1
        clc
        adc #SP_BOOM_A
        sta SPRPTR
        lda frame
        and #1
        beq @c1
        lda #7
        bne @c2
@c1:    lda #1
@c2:    sta $d027
        lda px
        sta sprx
        lda py
        sta spry
        rts
@hide:  lda #0
        sta spry
        rts

@alive: lda joy
        and #4                  ; left
        beq @nl
        lda px
        sec
        sbc pspeed
        bcc @nl
        cmp #2
        bcc @nl
        sta px
@nl:    lda joy
        and #8                  ; right
        beq @nr
        lda px
        clc
        adc pspeed
        cmp #237
        bcs @nr
        sta px
@nr:    lda joy
        and #1                  ; up
        beq @nu
        lda py
        sec
        sbc pspeed
        cmp #110
        bcc @nu
        sta py
@nu:    lda joy
        and #2                  ; down
        beq @nd
        lda py
        clc
        adc pspeed
        cmp #228
        bcs @nd
        sta py
@nd:    lda px
        sta sprx
        lda shield              ; shielded ship glows white
        beq @ns
        lda frame
        and #2
        beq @ns
        lda #1
        bne @sc
@ns:    lda #3
@sc:    sta $d027
        lda invuln
        beq @vis
        dec invuln
        lda frame
        and #4
        beq @vis
        lda #0
        sta spry
        rts
@vis:   lda py
        sta spry
        rts

player_fire:
        lda firecd
        beq @can
        dec firecd
        rts
@can:   lda dead
        bne @r
        lda joy
        and #$10
        beq @r
        lda #6
        sta firecd
        jsr sfx_laser
        lda py
        sec
        sbc #4
        sta sb_y
        lda #$f8                ; -8: one character row per frame
        sta sb_vy
        lda #PBCHAR
        sta tmp3
        lda weapon
        beq @single
        cmp #1
        beq @double
        cmp #2
        beq @triple
        jsr @double             ; 3: double + wide spread
        lda #$fd
        jmp @pair
@triple:
        jsr @single
        lda #$fe
@pair:  sta sb_vx               ; two diagonal shots (vx = a and -a)
        lda #SPCHAR
        sta tmp3
        lda px
        clc
        adc #8
        sta sb_x
        jsr spawn_pbullet
        lda #0
        sec
        sbc sb_vx
        sta sb_vx
        jmp spawn_pbullet
@single:
        lda #0
        sta sb_vx
        lda px
        clc
        adc #8
        sta sb_x
        jmp spawn_pbullet
@double:
        lda #0
        sta sb_vx
        lda px
        clc
        adc #2
        sta sb_x
        jsr spawn_pbullet
        lda px
        clc
        adc #14
        sta sb_x
        jmp spawn_pbullet
@r:     rts

player_hit:
        lda shield
        beq @die
        lda #0                  ; shield soaks it up
        sta shield
        lda #60
        sta invuln
        lda #12
        jsr sfx_expl
        lda #12
        sta flash
        lda #14
        sta flashc
        rts
@die:   lda #45
        jsr sfx_expl
        dec lives
        lda #90
        sta dead
        lda #24
        sta flash
        lda #2
        sta flashc
        lda #0                  ; lose your power-ups
        sta weapon
        lda #2
        sta pspeed
        rts

; ------------------------------------------------------------
;  bullets (drawn as characters)
; ------------------------------------------------------------
; spawn at sb_x/sb_y with sb_vx/sb_vy, char in tmp3 (x preserved)
spawn_pbullet:
        ldy #NPB-1
@f:     lda b_act,y
        beq @got
        dey
        bpl @f
        rts
@got:   lda tmp3
        sta b_ch,y
        jmp fill_bullet

spawn_ebullet:
        ldy #NB-1
@f:     lda b_act,y
        beq @got
        dey
        cpy #NPB
        bcs @f
        rts
@got:   lda #EBCHAR
        sta b_ch,y
fill_bullet:
        lda #1
        sta b_act,y
        lda sb_x
        sta b_x,y
        lda sb_y
        sta b_y,y
        lda sb_vx
        sta b_vx,y
        lda sb_vy
        sta b_vy,y
        lda #$ff
        sta b_row,y
        rts

move_bullets:
        ldx #NB-1
@l:     lda b_act,x
        beq @n
        lda b_x,x
        clc
        adc b_vx,x
        sta b_x,x
        cmp #2
        bcc @kill
        cmp #250
        bcs @kill
        lda b_y,x
        clc
        adc b_vy,x
        sta b_y,x
        cmp #TOPY-1
        bcc @kill
        cmp #248
        bcs @kill
        lda b_x,x               ; character cell
        clc
        adc #24
        ror
        lsr
        lsr
        sta tmp
        lda b_y,x
        sec
        sbc #50
        lsr
        lsr
        lsr
        sta tmp2
        cmp b_row,x
        bne @moved
        lda tmp
        cmp b_col,x
        beq @n
@moved: jsr erase_bullet
        jsr draw_bullet
        jmp @n
@kill:  jsr kill_bullet
@n:     dex
        bpl @l
        rts

kill_bullet:
        jsr erase_bullet
        lda #0
        sta b_act,x
        rts

clear_ebullets:
        ldx #NB-1
@l:     lda b_act,x
        beq @n
        jsr kill_bullet
@n:     dex
        cpx #NPB
        bcs @l
        rts

erase_bullet:
        ldy b_row,x
        cpy #$ff
        beq @r
        lda rowlo,y
        sta zp_t
        lda rowhi,y
        sta zp_t+1
        ldy b_col,x
        lda (zp_t),y
        cmp b_ch,x
        bne @gone
        lda #32
        sta (zp_t),y
@gone:  lda #$ff
        sta b_row,x
@r:     rts

; draw bullet x at column tmp, row tmp2 (only into empty or star cells)
draw_bullet:
        lda tmp
        sta b_col,x
        ldy tmp2
        lda rowlo,y
        sta zp_t
        sta zp_c
        lda rowhi,y
        sta zp_t+1
        clc
        adc #$d4
        sta zp_c+1
        ldy tmp
        lda (zp_t),y
        cmp #32
        beq @ok
        cmp #46
        bne @no
@ok:    lda b_ch,x
        sta (zp_t),y
        lda #7                  ; player shots yellow, enemy bullets pink/white
        cpx #NPB
        bcc @c
        lda frame
        and #2
        beq @w
        lda #10
        bne @c
@w:     lda #1
@c:     sta (zp_c),y
        lda tmp2
        sta b_row,x
        rts
@no:    lda #$ff
        sta b_row,x
        rts

; ------------------------------------------------------------
;  collisions
; ------------------------------------------------------------
collisions:
        ldx #NPB-1              ; player shots vs boss and enemies
@pb:    lda b_act,x
        beq @pbn
        lda boss_st
        cmp #2
        bne @enemies
        lda b_x,x
        sec
        sbc boss_x
        cmp #96
        bcs @enemies
        lda b_y,x
        sec
        sbc boss_y
        cmp #80
        bcs @enemies
        jsr kill_bullet
        jsr boss_hit
        jmp @pbn
@enemies:
        ldy #NE-1
@en:    lda e_state,y
        cmp #1
        bne @enn
        lda e_y,y
        cmp #TOPY
        bcc @enn
        lda b_x,x
        sec
        sbc e_x,y
        clc
        adc #4
        cmp #28
        bcs @enn
        lda b_y,x
        sec
        sbc e_y,y
        clc
        adc #8
        cmp #29
        bcs @enn
        sty tmp2                ; kill_bullet clobbers y
        jsr kill_bullet
        stx tmp3
        ldx tmp2
        jsr hit_enemy
        ldx tmp3
        jmp @pbn
@enn:   dey
        bpl @en
@pbn:   dex
        bpl @pb

        lda dead                ; the player
        beq @alive
        rts
@alive: lda cap_act             ; power-up pickup
        beq @nocap
        lda cap_x
        sec
        sbc px
        clc
        adc #18
        cmp #37
        bcs @nocap
        lda cap_y
        sec
        sbc py
        clc
        adc #18
        cmp #37
        bcs @nocap
        jsr collect_capsule
@nocap: lda invuln
        beq @vuln
        rts
@vuln:
        ldx #NB-1               ; enemy bullets (small hitbox, shmup style)
@eb:    lda b_act,x
        beq @ebn
        lda b_x,x
        sec
        sbc px
        sec
        sbc #3
        cmp #17
        bcs @ebn
        lda b_y,x
        sec
        sbc py
        sec
        sbc #2
        cmp #17
        bcs @ebn
        jsr kill_bullet
        jmp player_hit
@ebn:   dex
        cpx #NPB
        bcs @eb
        ldx #NE-1               ; enemy ships
@es:    lda e_state,x
        cmp #1
        bne @esn
        lda e_y,x
        cmp #TOPY
        bcc @esn
        lda e_x,x
        sec
        sbc px
        clc
        adc #14
        cmp #29
        bcs @esn
        lda e_y,x
        sec
        sbc py
        clc
        adc #14
        cmp #29
        bcs @esn
        jsr kill_enemy
        jmp player_hit
@esn:   dex
        bpl @es
        lda boss_st             ; ramming the boss
        cmp #2
        bne @done
        lda px
        clc
        adc #12
        sec
        sbc boss_x
        cmp #96
        bcs @done
        lda py
        clc
        adc #10
        sec
        sbc boss_y
        cmp #80
        bcs @done
        jmp player_hit
@done:  rts

; score += sc_mid/sc_lo (BCD)
add_score:
        sed
        clc
        lda score+2
        adc sc_lo
        sta score+2
        lda score+1
        adc sc_mid
        sta score+1
        lda score
        adc #0
        sta score
        cld
        rts

; ------------------------------------------------------------
cycle_divider:
        lda SCREEN+40           ; restore the line after a boss bar
        cmp #64
        beq @ok
        ldx #39
        lda #64
@r:     sta SCREEN+40,x
        dex
        bpl @r
@ok:    lda frame
        lsr
        sta tmp
        ldx #39
@l:     txa
        lsr
        lsr
        sec
        sbc tmp
        and #7
        tay
        lda grad,y
        sta COLRAM+40,x
        dex
        bpl @l
        rts

show_banner:
        pha
        tya
        pha
        jsr clear_banner
        pla
        tay
        pla
        jsr print_rec
        lda #90
        sta bannert
        rts

update_banner:
        lda bannert
        beq @r
        dec bannert
        beq clear_banner
        lda frame
        and #7
        tay
        lda grad,y
        ldx #11
@c:     sta COLRAM+12*40+14,x
        dex
        bpl @c
@r:     rts

clear_banner:
        ldx #11
        lda #32
@z:     sta SCREEN+12*40+14,x
        dex
        bpl @z
        rts

do_flash:
        lda flash
        beq @off
        dec flash
        and #2
        beq @off
        lda flashc
        sta $d020
        rts
@off:   lda #0
        sta $d020
        rts

; ============================================================
;  GAME OVER
; ============================================================
game_over:
        ldx #$ff
        txs
        lda #2
        sta state
        lda #0
        sta bannert
        lda #$1b
        sta $d011
        lda #12
        sta tempo
        jsr clear_banner
        jsr check_hiscore
        jsr clear_objects
        jsr draw_hud
        jsr draw_hud_values
        lda #<txt_over
        ldy #>txt_over
        jsr print_rec
        lda #120
        sta timer
@loop:  jsr wait_frame
        jsr move_stars
        jsr do_flash
        jsr sound_update
        lda frame
        lsr
        lsr
        and #7
        tay
        lda grad,y
        ldx #9
@c:     sta COLRAM+12*40+15,x
        dex
        bpl @c
        jsr read_joy
        inc frame
        lda timer
        beq @wait
        dec timer
        bne @more
        jsr menu_hint
@more:  jmp @loop
@wait:  lda joyprev
        eor #$ff
        and joy
        and #$10
        beq @loop
        jmp title

menu_hint:
        lda #<txt_menu
        ldy #>txt_menu
        jsr print_rec
        lda #<txt_firekey
        ldy #>txt_firekey
        jsr print_rec
        lda keycodes+4
        asl
        asl
        tax
        ldy #0
@c:     lda keynames,x
        cmp #32
        bne @p
        lda #96
@p:     sta SCREEN+16*40+24,y
        lda #7
        sta COLRAM+16*40+24,y
        inx
        iny
        cpy #4
        bne @c
        rts

check_hiscore:
        lda score
        cmp hiscore
        bcc @no
        bne @yes
        lda score+1
        cmp hiscore+1
        bcc @no
        bne @yes
        lda score+2
        cmp hiscore+2
        bcc @no
        beq @no
@yes:   lda score
        sta hiscore
        lda score+1
        sta hiscore+1
        lda score+2
        sta hiscore+2
@no:    rts

; ============================================================
;  STARFIELD
; ============================================================
init_stars:
        ldx #NSTARS-1
@l:     jsr rnd_col
        sta stx,x
        jsr rnd
        and #127
        sta tmp
        jsr rnd
        and #55
        clc
        adc tmp
        sta sty,x
        txa
        and #3
        tay
        lda star_speeds,y
        sta sts,x
        dex
        bpl @l
        rts

rnd_col:
        jsr rnd
        and #63
        cmp #40
        bcs rnd_col
        rts

move_stars:
        ldx #NSTARS-1
@l:     lda sty,x
        lsr
        lsr
        lsr
        sta tmp
        lda sty,x
        clc
        adc sts,x
        cmp #STARMAX
        bcc @nowrap
        jsr erase_star
        jsr rnd_col
        sta stx,x
        lda #0
        sta sty,x
        jmp @draw
@nowrap:
        sta sty,x
        lsr
        lsr
        lsr
        cmp tmp
        beq @next
        jsr erase_star
@draw:  jsr draw_star
@next:  dex
        bpl @l
        rts

erase_star:
        ldy tmp
        iny
        iny
        lda rowlo,y
        sta zp_t
        lda rowhi,y
        sta zp_t+1
        ldy stx,x
        lda (zp_t),y
        cmp #46
        bne @r
        lda #32
        sta (zp_t),y
@r:     rts

draw_star:
        ldy sts,x
        lda star_cols,y
        sta tmp2
        lda sty,x
        lsr
        lsr
        lsr
        tay
        iny
        iny
        lda rowlo,y
        sta zp_t
        sta zp_c
        lda rowhi,y
        sta zp_t+1
        clc
        adc #$d4
        sta zp_c+1
        ldy stx,x
        lda (zp_t),y
        cmp #32
        bne @r
        lda #46
        sta (zp_t),y
        lda tmp2
        sta (zp_c),y
@r:     rts

; ============================================================
;  KEYBOARD
; ============================================================
scan_any:
        lda #$ff
        sta $dc02
        lda #0
        sta $dc03
        ldx #7
@col:   lda colsel,x
        sta $dc00
        lda $dc01
        cmp #$ff
        bne @found
        dex
        bpl @col
        lda #$ff
        bne @out
@found: ldy #0
@bit:   lsr
        bcc @got
        iny
        bne @bit
@got:   sty tmp2
        txa
        asl
        asl
        asl
        ora tmp2
@out:   pha
        lda #$ff
        sta $dc00
        lda #0
        sta $dc02
        pla
        rts

apply_keys:
        ldx #4
@l:     lda keycodes,x
        lsr
        lsr
        lsr
        tay
        lda colsel,y
        sta kcol,x
        lda keycodes,x
        and #7
        tay
        lda bitmask,y
        sta krow,x
        dex
        bpl @l
        rts

draw_keynames:
        ldx #4
@slot:  lda slotoff,x
        clc
        adc #<(SCREEN+18*40+5)
        sta zp_ptr
        lda #>(SCREEN+18*40+5)
        adc #0
        sta zp_ptr+1
        lda keycodes,x
        cmp #$ff
        bne @name
        ldy #0
        lda #63
        sta (zp_ptr),y
        lda #96
        iny
        sta (zp_ptr),y
        iny
        sta (zp_ptr),y
        iny
        sta (zp_ptr),y
        jmp @next
@name:  asl
        asl
        sta tmp
        stx tmp2
        tax
        ldy #0
@ch:    lda keynames,x
        cmp #32
        bne @put
        lda #96
@put:   sta (zp_ptr),y
        inx
        iny
        cpy #4
        bne @ch
        ldx tmp2
@next:  dex
        bpl @slot
        rts

clear_menu:
        ldx #15
@row:   lda rowlo,x
        sta zp_ptr
        sta zp_col
        lda rowhi,x
        sta zp_ptr+1
        clc
        adc #$d4
        sta zp_col+1
        ldy #39
@c:     lda #32
        sta (zp_ptr),y
        lda #1
        sta (zp_col),y
        dey
        bpl @c
        inx
        cpx #23
        bne @row
        rts

; joystick port 2 OR the defined keys -> joy (bits: up 1, down 2, left 4, right 8, fire 16)
read_joy:
        lda joy
        sta joyprev
        lda #0
        sta $dc02
        sta $dc03
        lda $dc00
        eor #$ff
        and #$1f
        sta joy
        lda #$ff
        sta $dc02
        ldx #4
@key:   lda kcol,x
        sta $dc00
        lda $dc01
        and krow,x
        bne @up
        lda joy
        ora actbit,x
        sta joy
@up:    dex
        bpl @key
        lda #$ff
        sta $dc00
        lda #0
        sta $dc02
        rts

; ============================================================
;  SCREEN HELPERS
; ============================================================
wait_frame:
@w1:    lda $d011
        bmi @w1
@w2:    lda $d012
        cmp #250
        bne @w2
        rts

clear_screen:
        ldx #0
@l:     lda #32
        sta SCREEN,x
        sta SCREEN+$100,x
        sta SCREEN+$200,x
        sta SCREEN+$2e8,x
        lda #1
        sta COLRAM,x
        sta COLRAM+$100,x
        sta COLRAM+$200,x
        sta COLRAM+$2e8,x
        inx
        bne @l
        rts

hide_sprites:
        lda #0
        sta $d017
        sta $d01d
        ldx #7
@l:     sta spry,x
        dex
        bpl @l
        jmp update_sprites

; copy logical positions into the VIC (x + 48, 9th bit into $d010)
update_sprites:
        lda #0
        sta tmp
        ldx #7
@l:     txa
        asl
        tay
        lda sprx,x
        clc
        adc #48
        sta $d000,y
        rol tmp
        lda spry,x
        sta $d001,y
        dex
        bpl @l
        lda tmp
        sta $d010
        rts

rnd:    lda seed
        asl
        bcc @n
        eor #$1d
@n:     sta seed
        rts

print_rec:
        sta zp_ptr2
        sty zp_ptr2+1
        ldy #0
        lda (zp_ptr2),y
        tax
        lda rowlo,x
        sta zp_ptr
        lda rowhi,x
        sta zp_ptr+1
        iny
        lda (zp_ptr2),y
        clc
        adc zp_ptr
        sta zp_ptr
        bcc @nc
        inc zp_ptr+1
@nc:    iny
        lda (zp_ptr2),y
        sta tmp
        lda zp_ptr2
        clc
        adc #3
        sta zp_ptr2
        bcc @nc2
        inc zp_ptr2+1
@nc2:   lda zp_ptr
        sta zp_col
        lda zp_ptr+1
        clc
        adc #$d4
        sta zp_col+1
        ldy #0
@l:     lda (zp_ptr2),y
        beq @done
        cmp #32
        bne @put
        lda #96
@put:   sta (zp_ptr),y
        lda tmp
        sta (zp_col),y
        iny
        bne @l
@done:  rts

print_bcd:
        ldy #0
@l:     lda 0,x
        lsr
        lsr
        lsr
        lsr
        ora #$30
        sta (zp_ptr),y
        iny
        lda 0,x
        and #$0f
        ora #$30
        sta (zp_ptr),y
        iny
        inx
        cpy #6
        bne @l
        rts

draw_hud:
        ldx #39
@l:     lda #1
        sta COLRAM,x
        lda #64
        sta SCREEN+40,x
        lda #6
        sta COLRAM+40,x
        dex
        bpl @l
        lda #<txt_score
        ldy #>txt_score
        jsr print_rec
        lda #<txt_hilab
        ldy #>txt_hilab
        jsr print_rec
        lda #<txt_st
        ldy #>txt_st
        jsr print_rec
        lda #<txt_ships
        ldy #>txt_ships
        jmp print_rec

draw_hud_values:
        lda #<(SCREEN+6)
        sta zp_ptr
        lda #>(SCREEN+6)
        sta zp_ptr+1
        ldx #score
        jsr print_bcd
        lda #<(SCREEN+17)
        sta zp_ptr
        lda #>(SCREEN+17)
        sta zp_ptr+1
        ldx #hiscore
        jsr print_bcd
        lda stage
        ora #$30
        sta SCREEN+28
        lda lives
        ora #$30
        sta SCREEN+37
        rts

draw_logo:
        lda #<logo
        sta zp_ptr2
        lda #>logo
        sta zp_ptr2+1
        ldx #3
@row:   lda rowlo,x
        clc
        adc #10
        sta zp_ptr
        lda rowhi,x
        adc #0
        sta zp_ptr+1
        ldy #18
@c:     lda (zp_ptr2),y
        cmp #35
        bne @gap
        lda #160
        bne @put
@gap:   lda #96
@put:   sta (zp_ptr),y
        dey
        bpl @c
        lda zp_ptr2
        clc
        adc #19
        sta zp_ptr2
        bcc @n
        inc zp_ptr2+1
@n:     inx
        cpx #14
        bne @row
        rts

color_logo:
        lda frame
        lsr
        lsr
        sta tmp
        ldx #3
@r:     txa
        clc
        adc tmp
        and #7
        tay
        lda grad,y
        sta tmp2
        lda rowlo,x
        clc
        adc #10
        sta zp_col
        lda rowhi,x
        adc #$d4
        sta zp_col+1
        ldy #18
        lda tmp2
@c:     sta (zp_col),y
        dey
        bpl @c
        inx
        cpx #14
        bne @r
        rts

; ============================================================
;  SOUND
; ============================================================
sid_init:
        ldx #$18
        lda #0
@l:     sta $d400,x
        dex
        bpl @l
        lda #$09
        sta $d405
        lda #$00
        sta $d406
        lda #$0a
        sta $d40c
        lda #$00
        sta $d40d
        lda #$08
        sta $d40a
        lda #$0c
        sta $d413
        lda #$00
        sta $d414
        lda #$0f
        sta $d418
        rts

sfx_laser:
        lda sfxup               ; don't cut off the power-up jingle
        bne @r
        lda #$38
        sta lasfreq
        sta $d401
        lda #$20
        sta $d404
        lda #$21
        sta $d404
        lda #8
        sta sfxlas
@r:     rts

sfx_power:
        lda #1
        sta sfxup
        lda #$10
        sta lasfreq
        sta $d401
        lda #$10
        sta $d404
        lda #$11
        sta $d404
        lda #24
        sta sfxlas
        rts

; A = duration in frames
sfx_expl:
        cmp sfxexp              ; don't let small bangs cut off big ones
        bcc @r
        sta sfxexp
        lda #$28
        sta expfreq
        sta $d40f
        lda #$80
        sta $d412
        lda #$81
        sta $d412
@r:     rts

sound_update:
        lda sfxlas
        beq @l2
        dec sfxlas
        bne @l1
        lda #$20
        sta $d404
        lda #0
        sta sfxup
        jmp @l2
@l1:    lda sfxup
        bne @rise
        lda lasfreq
        sec
        sbc #3
        jmp @set
@rise:  lda lasfreq
        clc
        adc #6
@set:   sta lasfreq
        sta $d401
@l2:    lda sfxexp
        beq @e2
        dec sfxexp
        bne @e1
        lda #$80
        sta $d412
        jmp @e2
@e1:    lda expfreq
        beq @e2
        dec expfreq
        lda expfreq
        sta $d40f
@e2:    lda state
        cmp #1
        bne @b
        inc beat
        lda beat
        cmp tempo
        bcc @b
        lda #0
        sta beat
        inc note
        lda note
        and #15
        tay
        lda bass_lo,y
        sta $d407
        lda bass_hi,y
        sta $d408
        lda #$40
        sta $d40b
        lda #$41
        sta $d40b
@b:     rts

; ============================================================
;  DATA
; ============================================================
; enemy types: 0 fighter, 1 kamikaze dart, 2 gunship, 3 invader
type_spr:    .byte SP_FIGHTER_A, SP_DIVER_A, SP_HEAVY_A, SP_ALIEN_A
type_col:    .byte 14, 10, 8, 13
type_hp:     .byte 1, 1, 5, 1
type_fire:   .byte 3, 0, 5, 4       ; chance per frame (/256)
type_flags:  .byte 0, 1, 2, 0       ; 1 = homing, 2 = 3-way spread shot
type_sclo:   .byte $00, $50, $00, $50
type_scmid:  .byte $01, $01, $05, $00
T_FIGHTER = 0
T_DIVER   = 1
T_HEAVY   = 2
T_ALIEN   = 3

; stage script: type, path, count, spacing, x, mirror, delay-after ($ff = boss)
stage_script:
        .byte T_FIGHTER, PATH_UTURN, 5, 14, 40, 0, 50
        .byte T_FIGHTER, PATH_UTURN, 5, 14, 196, 1, 90
        .byte T_ALIEN,   PATH_SNAKE, 5, 18, 100, 0, 60
        .byte T_DIVER,   PATH_DIVE,  3, 22, 50, 0, 30
        .byte T_DIVER,   PATH_DIVE,  3, 22, 190, 0, 90
        .byte T_FIGHTER, PATH_LOOP,  5, 12, 40, 0, 40
        .byte T_FIGHTER, PATH_LOOP,  5, 12, 196, 1, 110
        .byte T_HEAVY,   PATH_HOVER, 1, 1, 110, 0, 60
        .byte T_FIGHTER, PATH_SWEEP, 5, 12, 30, 0, 50
        .byte T_FIGHTER, PATH_SWEEP, 5, 12, 206, 1, 90
        .byte T_ALIEN,   PATH_WEAVE, 6, 16, 70, 0, 20
        .byte T_ALIEN,   PATH_WEAVE, 6, 16, 150, 1, 90
        .byte T_DIVER,   PATH_DIVE,  4, 16, 120, 0, 60
        .byte T_HEAVY,   PATH_HOVER, 1, 1, 50, 0, 50
        .byte T_HEAVY,   PATH_HOVER, 1, 1, 170, 0, 120
        .byte T_FIGHTER, PATH_UTURN, 6, 12, 60, 0, 30
        .byte T_FIGHTER, PATH_UTURN, 6, 12, 176, 1, 200
        .byte $ff

esc_off:     .byte 10, 70
cap_spr:     .byte SP_CAP_P, SP_CAP_S, SP_CAP_B
cap_col:     .byte 7, 5, 14
grad:        .byte 4, 14, 3, 1, 3, 14, 4, 6
star_speeds: .byte 1, 2, 3, 5
star_cols:   .byte 0, 11, 12, 15, 1, 1
bass_lo:     .byte $a9, $a9, $5a, $a9, $7b, $a9, $e2, $5a, $42, $42, $3e, $42, $e2, $42, $7b, $e2
bass_hi:     .byte $03, $03, $04, $03, $05, $03, $04, $04, $03, $03, $03, $03, $04, $03, $05, $04

default_keys: .byte 38, 41, 62, 10, 60
actbit:      .byte 4, 8, 1, 2, 16
colsel:      .byte $fe, $fd, $fb, $f7, $ef, $df, $bf, $7f
bitmask:     .byte 1, 2, 4, 8, 16, 32, 64, 128
slotoff:     .byte 0, 6, 12, 18, 24
act_lo:      .byte <txt_a_left, <txt_a_right, <txt_a_up, <txt_a_down, <txt_a_fire
act_hi:      .byte >txt_a_left, >txt_a_right, >txt_a_up, >txt_a_down, >txt_a_fire

; text records: row, column, colour, screen codes, 0
txt_fire:    .byte 15, 10, 1
             .scr "PRESS FIRE TO START"
             .byte 0
txt_labels:  .byte 17, 5, 12
             .scr "LEFT  RIGHT UP    DOWN  FIRE"
             .byte 0
txt_f1:      .byte 20, 11, 7
             .scr "F1  REDEFINE KEYS"
             .byte 0
txt_joy:     .byte 21, 6, 11
             .scr "OR USE A JOYSTICK IN PORT 2"
             .byte 0
txt_redef:   .byte 15, 13, 3
             .scr "REDEFINE  KEYS"
             .byte 0
txt_press:   .byte 20, 11, 1
             .scr "PRESS KEY FOR"
             .byte 0
txt_done:    .byte 20, 11, 5
             .scr "   ALL SET!        "
             .byte 0
txt_a_left:  .byte 20, 25, 7
             .scr "LEFT "
             .byte 0
txt_a_right: .byte 20, 25, 7
             .scr "RIGHT"
             .byte 0
txt_a_up:    .byte 20, 25, 7
             .scr "UP   "
             .byte 0
txt_a_down:  .byte 20, 25, 7
             .scr "DOWN "
             .byte 0
txt_a_fire:  .byte 20, 25, 7
             .scr "FIRE "
             .byte 0
txt_hi:      .byte 23, 15, 3
             .scr "HI  "
             .byte 0
txt_credit:  .byte 24, 5, 11
             .scr "BUILT BY CLAUDE WITH VICE-MCP"
             .byte 0
txt_score:   .byte 0, 0, 3
             .scr "SCORE"
             .byte 0
txt_hilab:   .byte 0, 14, 3
             .scr "HI"
             .byte 0
txt_st:      .byte 0, 25, 3
             .scr "ST"
             .byte 0
txt_ships:   .byte 0, 31, 3
             .scr "SHIPS"
             .byte 0
txt_over:    .byte 12, 15, 1
             .scr "GAME  OVER"
             .byte 0
txt_menu:    .byte 14, 10, 1
             .scr "PRESS FIRE FOR MENU"
             .byte 0
txt_firekey: .byte 16, 12, 12
             .scr "FIRE KEY IS"
             .byte 0
txt_ready:   .byte 12, 15, 1
             .scr "GET READY!"
             .byte 0
txt_warning: .byte 12, 16, 2
             .scr "WARNING!"
             .byte 0
txt_clear:   .byte 12, 14, 5
             .scr "STAGE CLEAR!"
             .byte 0
txt_power:   .byte 12, 15, 7
             .scr "POWER UP!"
             .byte 0
txt_speed:   .byte 12, 15, 5
             .scr "SPEED UP!"
             .byte 0
txt_shield:  .byte 12, 16, 14
             .scr "SHIELD!"
             .byte 0

; sprites must live in VIC bank 0 outside $1000-$1fff (char ROM shadow)
        * = $3000
        .include "data.asm"

# -*- coding: utf-8 -*-
"""Ready-to-test classic games for Toby Game Review."""

SAMPLE_GAMES = [
    {
        "id": "opera-game",
        "title": "Morphy'nin Opera Oyunu (1858)",
        "subtitle": "17 hamle · Hızlı test için ideal klasik hücum",
        "time_control": "Classical",
        "pgn": """[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.11.02"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[WhiteElo "2550"]
[BlackElo "1800"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0""",
    },
    {
        "id": "carlsen-anand",
        "title": "Carlsen - Anand (2014 Dünya Şampiyonası)",
        "subtitle": "34 hamle · Büyükusta düzeyinde konumsal mücadele",
        "time_control": "Classical",
        "pgn": """[Event "World Chess Championship 2014"]
[Site "Sochi RUS"]
[Date "2014.11.09"]
[White "Magnus Carlsen"]
[Black "Viswanathan Anand"]
[WhiteElo "2863"]
[BlackElo "2792"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3 Bc5 5. O-O d6 6. Re1 O-O 7. Bxc6 bxc6
8. h3 Re8 9. Nbd2 Nd7 10. Nc4 Bb6 11. a4 a5 12. Nxb6 cxb6 13. d4 Qc7
14. Ra3 Nf8 15. dxe5 dxe5 16. Nh4 Rd8 17. Qh5 f6 18. Nf5 Be6 19. Rg3 Ng6
20. h4 Bxf5 21. exf5 Nf4 22. Bxf4 exf4 23. Rc3 c5 24. Re6 Rab8 25. Rc4 Qd7
26. Kh2 Rf8 27. Rce4 Rb7 28. Qe2 b5 29. b3 bxa4 30. bxa4 Rb4 31. Re7 Qd6
32. Qf3 Rxe4 33. Qxe4 f3+ 34. g3 h5 1-0""",
    },
    {
        "id": "club-tactical",
        "title": "Kulüp Maçı — İtalyan Açılışı (1600 vs 1600)",
        "subtitle": "22 hamle · Amatör / kulüp seviyesi taktik hatalar",
        "time_control": "Rapid",
        "pgn": """[Event "Kulüp Turnuvası"]
[White "Ahmet"]
[Black "Mehmet"]
[WhiteElo "1600"]
[BlackElo "1600"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Bd2 Bxd2+
8. Nbxd2 d5 9. exd5 Nxd5 10. Qb3 Nce7 11. O-O O-O 12. Rfe1 c6 13. Ne4 Bf5
14. Ng3 Bg6 15. Ne5 Qc7 16. Rac1 Rad8 17. Nxg6 hxg6 18. Ne4 Rfe8 19. Ng5 Qd7
20. Qh3 Qxh3 21. Nxh3 Nf5 22. Rxe8+ Rxe8 1-0""",
    },
]

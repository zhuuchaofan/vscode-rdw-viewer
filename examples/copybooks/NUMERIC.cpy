      * 数値形式のサンプル（60 バイト）
       01  NUMERIC-REC.
           05  NUM-ID              PIC 9(4).
           05  N-ZONED             PIC S9(5)V99.
           05  N-LEAD-SEP          PIC S9(5) SIGN LEADING SEPARATE.
           05  N-TRAIL-SEP         PIC S9(5) SIGN TRAILING SEPARATE.
           05  N-PACKED            PIC S9(7)V99 COMP-3.
           05  N-BINARY            PIC S9(4) COMP.
           05  N-BINARY-L          PIC S9(9) BINARY.
           05  N-NATIVE            PIC S9(9) COMP-5.
           05  N-FLOAT             COMP-1.
           05  N-DOUBLE            COMP-2.
           05  N-NOTE              PIC X(10).

000100*---------------------------------------------------------------- CUSTMAST
000200*    顧客マスター（サンプル）   レコード長 120 バイト             CUSTMAST
000300*---------------------------------------------------------------- CUSTMAST
000400 01  CUSTOMER-REC.                                                CUSTMAST
000500     05  CUST-ID             PIC 9(8).                            CUSTMAST
000600     05  CUST-NAME           PIC X(30).                           CUSTMAST
000700     05  CUST-KANA           PIC X(20).                           CUSTMAST
000800     05  CUST-BIRTH          PIC 9(8).                            CUSTMAST
000900     05  CUST-RANK           PIC X(1).                            CUSTMAST
001000*        残高・ポイントはパック 10 進                             CUSTMAST
001100     05  CUST-BALANCE        PIC S9(9)V99  COMP-3.                CUSTMAST
001200     05  CUST-POINT          PIC S9(7)     COMP-3.                CUSTMAST
001300*        与信限度額はゾーン 10 進（符号は末尾桁に含む）           CUSTMAST
001400     05  CUST-LIMIT          PIC S9(9)V99.                        CUSTMAST
001500     05  CUST-UPDATED        PIC 9(14).                           CUSTMAST
001600     05  FILLER              PIC X(18).                           CUSTMAST

   14051a477:	48 85 c0             	test   rax,rax
   14051a47a:	74 03                	je     0x14051a47f
   14051a47c:	48 ff e0             	rex.W jmp rax
   14051a47f:	c3                   	ret
   14051a480:	48 8b 05 f9 3d 44 01 	mov    rax,QWORD PTR [rip+0x1443df9]        # 0x14195e280
   14051a487:	48 85 c0             	test   rax,rax
   14051a48a:	74 03                	je     0x14051a48f
   14051a48c:	48 ff e0             	rex.W jmp rax
   14051a48f:	c3                   	ret
--
   14051a797:	48 85 c0             	test   rax,rax
   14051a79a:	74 03                	je     0x14051a79f
   14051a79c:	48 ff e0             	rex.W jmp rax
   14051a79f:	c3                   	ret
   14051a7a0:	48 8b 05 a1 38 44 01 	mov    rax,QWORD PTR [rip+0x14438a1]        # 0x14195e048
   14051a7a7:	48 85 c0             	test   rax,rax
   14051a7aa:	74 03                	je     0x14051a7af
   14051a7ac:	48 ff e0             	rex.W jmp rax
   14051a7af:	c3                   	ret
   14051a7b0:	48 8b 05 21 4e 44 01 	mov    rax,QWORD PTR [rip+0x1444e21]        # 0x14195f5d8
   14051a7b7:	48 85 c0             	test   rax,rax
   14051a7ba:	74 03                	je     0x14051a7bf
   14051a7bc:	48 ff e0             	rex.W jmp rax
   14051a7bf:	c3                   	ret
--
   140d43916:	48 89 41 38          	mov    QWORD PTR [rcx+0x38],rax
   140d4391a:	48 89 41 40          	mov    QWORD PTR [rcx+0x40],rax
   140d4391e:	e8 7d 0a 00 00       	call   0x140d443a0
   140d43923:	48 8d 05 a6 05 00 00 	lea    rax,[rip+0x5a6]        # 0x140d43ed0
   140d4392a:	48 89 05 a7 bc c1 00 	mov    QWORD PTR [rip+0xc1bca7],rax        # 0x14195f5d8
   140d43931:	48 8d 05 e8 01 00 00 	lea    rax,[rip+0x1e8]        # 0x140d43b20
   140d43938:	48 89 05 09 a7 c1 00 	mov    QWORD PTR [rip+0xc1a709],rax        # 0x14195e048
   140d4393f:	48 8d 05 5a 09 00 00 	lea    rax,[rip+0x95a]        # 0x140d442a0
   140d43946:	48 89 05 33 a9 c1 00 	mov    QWORD PTR [rip+0xc1a933],rax        # 0x14195e280
   140d4394d:	48 8d 05 5c 09 00 00 	lea    rax,[rip+0x95c]        # 0x140d442b0
   140d43954:	48 89 05 ad b0 c1 00 	mov    QWORD PTR [rip+0xc1b0ad],rax        # 0x14195ea08
   140d4395b:	48 8b c3             	mov    rax,rbx
   140d4395e:	48 83 c4 20          	add    rsp,0x20


/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

000000014050d4b0 <.text+0x50c4b0>:
   14050d4b0:	40 53                	rex push rbx
   14050d4b2:	48 83 ec 30          	sub    rsp,0x30
   14050d4b6:	8b 44 24 60          	mov    eax,DWORD PTR [rsp+0x60]
   14050d4ba:	48 89 51 08          	mov    QWORD PTR [rcx+0x8],rdx
   14050d4be:	48 8b d9             	mov    rbx,rcx
   14050d4c1:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050d4c4:	48 8d 05 05 a8 f8 00 	lea    rax,[rip+0xf8a805]        # 0x141497cd0
   14050d4cb:	4c 89 41 10          	mov    QWORD PTR [rcx+0x10],r8
   14050d4cf:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050d4d2:	33 c0                	xor    eax,eax
   14050d4d4:	48 8d 4c 24 20       	lea    rcx,[rsp+0x20]
   14050d4d9:	0f b6 d0             	movzx  edx,al
   14050d4dc:	4c 89 4c 24 20       	mov    QWORD PTR [rsp+0x20],r9
   14050d4e1:	66 c7 44 24 28 00 08 	mov    WORD PTR [rsp+0x28],0x800
   14050d4e8:	e8 c3 27 fc ff       	call   0x1404cfcb0
   14050d4ed:	89 43 20             	mov    DWORD PTR [rbx+0x20],eax
   14050d4f0:	48 8b c3             	mov    rax,rbx
   14050d4f3:	48 83 c4 30          	add    rsp,0x30
   14050d4f7:	5b                   	pop    rbx
   14050d4f8:	c3                   	ret
   14050d4f9:	75 ca                	jne    0x14050d4c5
   14050d4fb:	96                   	xchg   esi,eax
   14050d4fc:	72 d4                	jb     0x14050d4d2
   14050d4fe:	8f                   	(bad)
   14050d4ff:	76 48                	jbe    0x14050d549
   14050d501:	89 5c 24 08          	mov    DWORD PTR [rsp+0x8],ebx
   14050d505:	57                   	push   rdi
   14050d506:	48 83 ec 20          	sub    rsp,0x20
   14050d50a:	8b 44 24 50          	mov    eax,DWORD PTR [rsp+0x50]
   14050d50e:	48 89 51 08          	mov    QWORD PTR [rcx+0x8],rdx
   14050d512:	48 8b d9             	mov    rbx,rcx
   14050d515:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050d518:	48 8d 05 b1 a7 f8 00 	lea    rax,[rip+0xf8a7b1]        # 0x141497cd0
   14050d51f:	4c 89 41 10          	mov    QWORD PTR [rcx+0x10],r8
   14050d523:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050d526:	48 8d 54 24 50       	lea    rdx,[rsp+0x50]
   14050d52b:	49 8b c9             	mov    rcx,r9
   14050d52e:	49 8b f9             	mov    rdi,r9
   14050d531:	c7 44 24 50 00 00 00 	mov    DWORD PTR [rsp+0x50],0x0
   14050d538:	00 
   14050d539:	e8 92 46 ca ff       	call   0x1401b1bd0
   14050d53e:	8b 44 24 50          	mov    eax,DWORD PTR [rsp+0x50]
   14050d542:	48 8d 53 28          	lea    rdx,[rbx+0x28]
   14050d546:	48 8b cf             	mov    rcx,rdi
   14050d549:	89 43 20             	mov    DWORD PTR [rbx+0x20],eax
   14050d54c:	e8 af 68 84 00       	call   0x140d53e00
   14050d551:	48 8b c3             	mov    rax,rbx
   14050d554:	48 8b 5c 24 30       	mov    rbx,QWORD PTR [rsp+0x30]
   14050d559:	48 83 c4 20          	add    rsp,0x20
   14050d55d:	5f                   	pop    rdi
   14050d55e:	c3                   	ret
   14050d55f:	cc                   	int3
   14050d560:	40 53                	rex push rbx
   14050d562:	48 83 ec 20          	sub    rsp,0x20
   14050d566:	8b 44 24 50          	mov    eax,DWORD PTR [rsp+0x50]
   14050d56a:	48 89 51 08          	mov    QWORD PTR [rcx+0x8],rdx
   14050d56e:	4c 89 41 10          	mov    QWORD PTR [rcx+0x10],r8
   14050d572:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050d575:	48 8d 05 64 d6 de 00 	lea    rax,[rip+0xded664]        # 0x1412fabe0
   14050d57c:	41 b0 01             	mov    r8b,0x1
   14050d57f:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050d582:	49 8b d1             	mov    rdx,r9
   14050d585:	48 8b d9             	mov    rbx,rcx
   14050d588:	c7 81 98 00 00 00 00 	mov    DWORD PTR [rcx+0x98],0x0
   14050d58f:	00 00 00 
   14050d592:	e8 b9 17 01 00       	call   0x14051ed50
   14050d597:	48 8b c3             	mov    rax,rbx
   14050d59a:	48 83 c4 20          	add    rsp,0x20
   14050d59e:	5b                   	pop    rbx
   14050d59f:	c3                   	ret
   14050d5a0:	48 89 5c 24 08       	mov    QWORD PTR [rsp+0x8],rbx
   14050d5a5:	57                   	push   rdi
   14050d5a6:	48 83 ec 20          	sub    rsp,0x20
   14050d5aa:	8b 44 24 50          	mov    eax,DWORD PTR [rsp+0x50]
   14050d5ae:	48                   	rex.W
   14050d5af:	89                   	.byte 0x89

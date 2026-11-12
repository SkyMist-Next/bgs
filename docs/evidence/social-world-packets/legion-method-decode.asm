
/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

0000000140503d00 <.text+0x502d00>:
   140503d00:	48 89 5c 24 10       	mov    QWORD PTR [rsp+0x10],rbx
   140503d05:	57                   	push   rdi
   140503d06:	48 83 ec 20          	sub    rsp,0x20
   140503d0a:	48 8b da             	mov    rbx,rdx
   140503d0d:	48 8b f9             	mov    rdi,rcx
   140503d10:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503d15:	48 8b cb             	mov    rcx,rbx
   140503d18:	48 c7 44 24 30 00 00 	mov    QWORD PTR [rsp+0x30],0x0
   140503d1f:	00 00 
   140503d21:	e8 fa de ca ff       	call   0x1401b1c20
   140503d26:	48 8b 44 24 30       	mov    rax,QWORD PTR [rsp+0x30]
   140503d2b:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503d30:	48 8b cb             	mov    rcx,rbx
   140503d33:	48 89 07             	mov    QWORD PTR [rdi],rax
   140503d36:	48 c7 44 24 30 00 00 	mov    QWORD PTR [rsp+0x30],0x0
   140503d3d:	00 00 
   140503d3f:	e8 dc de ca ff       	call   0x1401b1c20
   140503d44:	48 8b 44 24 30       	mov    rax,QWORD PTR [rsp+0x30]
   140503d49:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503d4e:	48 8b cb             	mov    rcx,rbx
   140503d51:	48 89 47 08          	mov    QWORD PTR [rdi+0x8],rax
   140503d55:	c7 44 24 30 00 00 00 	mov    DWORD PTR [rsp+0x30],0x0
   140503d5c:	00 
   140503d5d:	e8 6e de ca ff       	call   0x1401b1bd0
   140503d62:	8b 44 24 30          	mov    eax,DWORD PTR [rsp+0x30]
   140503d66:	48 8b 5c 24 38       	mov    rbx,QWORD PTR [rsp+0x38]
   140503d6b:	89 47 10             	mov    DWORD PTR [rdi+0x10],eax
   140503d6e:	48 83 c4 20          	add    rsp,0x20
   140503d72:	5f                   	pop    rdi
   140503d73:	c3                   	ret
   140503d74:	c6                   	(bad)
   140503d75:	8e a3 7b 8f 0e 40    	mov    fs,WORD PTR [rbx+0x400e8f7b]
   140503d7b:	d0 94 9d 81 42 48 89 	rcl    BYTE PTR [rbp+rbx*4-0x76b7bd7f],1
   140503d82:	5c                   	pop    rsp
   140503d83:	24 18                	and    al,0x18
   140503d85:	48 89 74 24 20       	mov    QWORD PTR [rsp+0x20],rsi
   140503d8a:	57                   	push   rdi
   140503d8b:	48 83 ec 20          	sub    rsp,0x20
   140503d8f:	48 8b fa             	mov    rdi,rdx
   140503d92:	48 8b f1             	mov    rsi,rcx
   140503d95:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503d9a:	48 8b cf             	mov    rcx,rdi
   140503d9d:	c6 44 24 30 00       	mov    BYTE PTR [rsp+0x30],0x0
   140503da2:	e8 89 dd ca ff       	call   0x1401b1b30
   140503da7:	0f b6 44 24 30       	movzx  eax,BYTE PTR [rsp+0x30]
   140503dac:	48 8d 54 24 38       	lea    rdx,[rsp+0x38]
   140503db1:	48 8b cf             	mov    rcx,rdi
   140503db4:	c6 44 24 38 00       	mov    BYTE PTR [rsp+0x38],0x0
   140503db9:	8d 1c 85 00 00 00 00 	lea    ebx,[rax*4+0x0]
   140503dc0:	e8 6b dd ca ff       	call   0x1401b1b30
   140503dc5:	0f b6 44 24 38       	movzx  eax,BYTE PTR [rsp+0x38]
   140503dca:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503dcf:	c1 e8 06             	shr    eax,0x6
   140503dd2:	48 8b cf             	mov    rcx,rdi
   140503dd5:	0b c3                	or     eax,ebx
   140503dd7:	33 db                	xor    ebx,ebx
   140503dd9:	89 5c 24 30          	mov    DWORD PTR [rsp+0x30],ebx
   140503ddd:	89 06                	mov    DWORD PTR [rsi],eax
   140503ddf:	e8 ec dd ca ff       	call   0x1401b1bd0
   140503de4:	8b 44 24 30          	mov    eax,DWORD PTR [rsp+0x30]
   140503de8:	48 8d 54 24 30       	lea    rdx,[rsp+0x30]
   140503ded:	48 8b cf             	mov    rcx,rdi
